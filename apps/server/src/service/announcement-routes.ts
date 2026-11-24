import type { FastifyInstance, FastifyRequest } from "fastify";
import { registeredArchive } from "../archivist/access.js";
import {
  type AnnouncementSnapshot,
  type ClaimedAnnouncement,
  claimQueuedAnnouncements,
  deliveryState,
  finishAnnouncement,
  reportAnnouncement,
} from "../archivist/announcements.js";
import { readArtifact } from "../archivist/artifacts.js";
import { type ArchivistContext, openStore } from "../archivist/context.js";
import { ArchivistError } from "../archivist/errors.js";
import { discordId } from "../archivist/fields.js";
import { archiveIdValue } from "../archivist/paths.js";
import type { ServiceAuth } from "./service-auth.js";

/**
 * The Discord bot's side of upload announcements. A new artifact's post
 * waits in a queue with a snapshot of the artifact as it was submitted. The
 * bot claims posts, sends each to its archive's logs channel, and reports
 * how it went under the claim's ID. A claim is handed out once. A claim not
 * reported within the lease becomes indeterminate and is never handed out
 * again, because the post may already be in the channel. These routes need
 * the service credential and act for no contributor.
 */

const DEFAULT_CLAIMS = 10;
const MAX_CLAIMS = 25;
const MAX_REASON_LENGTH = 200;
const RESULT_STATES = ["sent", "failed", "indeterminate"] as const;
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIM_ID = ARTIFACT_ID;

/** Everything the bot needs to post one artifact's announcement. */
export interface AnnouncementItem extends AnnouncementSnapshot {
  archiveId: string;
  artifactId: string;
  claimId: string;
  channel: { guildId: string; channelId: string };
  /** Where the bot downloads the preview, relative to the service's base address. */
  previewPath: string | null;
}

type Params = { archiveId: string; artifactId: string };

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ArchivistError("invalid_input", "Send the fields as a JSON object.");
  }
  return body as Record<string, unknown>;
}

function claimLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_CLAIMS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CLAIMS) {
    throw new ArchivistError(
      "invalid_input",
      `limit must be a whole number from 1 to ${MAX_CLAIMS}.`,
      { field: "limit" },
    );
  }
  return value;
}

function uuidValue(field: string, value: unknown): string {
  if (typeof value !== "string" || !ARTIFACT_ID.test(value)) {
    throw new ArchivistError("invalid_input", `${field} must be a full ID.`, { field });
  }
  return value;
}

function previewPath(archiveId: string, artifactId: string): string {
  return `/api/service/announcements/${archiveId}/${artifactId}/preview`;
}

export function registerAnnouncementRoutes(
  scope: FastifyInstance,
  context: ArchivistContext,
  service: ServiceAuth,
  logError: (message: string, error: unknown) => void,
): void {
  /** A claimed post ready to send, or null after recording why it cannot be sent. */
  function itemOf(claim: ClaimedAnnouncement): AnnouncementItem | null {
    const giveUp = (errorCode: string) => {
      finishAnnouncement(context, { ...claim, state: "failed", errorCode });
      return null;
    };
    try {
      const store = openStore(context, claim.archiveId);
      // An artifact deleted before the bot claimed its post is never announced.
      if (!readArtifact(store.db, claim.artifactId)) return giveUp("artifact_deleted");
      return {
        ...claim.snapshot,
        archiveId: claim.archiveId,
        artifactId: claim.artifactId,
        claimId: claim.claimId,
        channel: { guildId: claim.guildId, channelId: claim.channelId },
        previewPath: claim.snapshot.artifact.media.hasPreview
          ? previewPath(claim.archiveId, claim.artifactId)
          : null,
      };
    } catch (error) {
      logError("Could not prepare an announcement", error);
      return giveUp("archive_unavailable");
    }
  }

  /**
   * Claims waiting posts, oldest first. `archiveId` and `artifactId` narrow
   * the claim, such as to the artifact the bot has just submitted, so it can
   * tell the contributor how the post went.
   */
  scope.post("/api/service/announcements/claim", async (request) => {
    service.requireService(request);
    const body = bodyOf(request);
    const claims = claimQueuedAnnouncements(context, {
      archiveId:
        body.archiveId === undefined || body.archiveId === null
          ? null
          : archiveIdValue("archiveId", body.archiveId),
      artifactId:
        body.artifactId === undefined || body.artifactId === null
          ? null
          : uuidValue("artifactId", body.artifactId),
      limit: claimLimit(body.limit),
    });
    return { items: claims.map(itemOf).filter((item) => item !== null) };
  });

  /** The preview image for a claimed post, which the bot attaches to the message. */
  scope.get<{ Params: Params }>(
    "/api/service/announcements/:archiveId/:artifactId/preview",
    async (request, reply) => {
      service.requireService(request);
      const archiveId = archiveIdValue("archiveId", request.params.archiveId);
      const { artifactId } = request.params;
      if (
        !registeredArchive(context, archiveId) ||
        deliveryState(context, archiveId, artifactId) === null
      ) {
        throw new ArchivistError("not_found", "That artifact has no claimed announcement.");
      }
      const store = openStore(context, archiveId);
      const row = store.db
        .prepare(
          "SELECT m.preview_path AS previewPath FROM artifacts a JOIN media m ON m.id = a.media_id WHERE a.id = ?",
        )
        .get(artifactId) as { previewPath: string | null } | undefined;
      if (!row?.previewPath) throw new ArchivistError("not_found", "That artifact has no preview.");
      reply.header("cache-control", "private, no-store");
      reply.header("content-type", "image/webp");
      return reply.sendFile(row.previewPath, store.folder, { cacheControl: false });
    },
  );

  /**
   * How a claimed post went: sent with its message, definitely failed, or
   * unknown. Repeating the same report is harmless.
   */
  scope.post<{ Params: Params }>(
    "/api/service/announcements/:archiveId/:artifactId/result",
    async (request, reply) => {
      service.requireService(request);
      const archiveId = archiveIdValue("archiveId", request.params.archiveId);
      const body = bodyOf(request);
      const state = body.state as (typeof RESULT_STATES)[number];
      if (!RESULT_STATES.includes(state)) {
        throw new ArchivistError("invalid_input", "state must be sent, failed, or indeterminate.", {
          field: "state",
        });
      }
      if (typeof body.claimId !== "string" || !CLAIM_ID.test(body.claimId)) {
        throw new ArchivistError("invalid_input", "claimId must be the ID the claim returned.", {
          field: "claimId",
        });
      }
      const messageId = state === "sent" ? discordId("messageId", body.messageId) : undefined;
      const reason =
        body.reason === undefined || body.reason === null ? undefined : String(body.reason);
      if (reason !== undefined && reason.length > MAX_REASON_LENGTH) {
        throw new ArchivistError("invalid_input", "reason can be at most 200 characters.", {
          field: "reason",
        });
      }
      const outcome = reportAnnouncement(context, {
        archiveId,
        artifactId: request.params.artifactId,
        claimId: body.claimId,
        state,
        messageId,
        errorCode: reason,
      });
      if (outcome === "unknown_claim") {
        throw new ArchivistError("not_found", "There is no such claim for that artifact.", {
          reason: "unknown_claim",
        });
      }
      if (outcome === "stale_claim") {
        throw new ArchivistError(
          "stale_version",
          "That claim was already settled differently, or a newer claim replaced it.",
          { reason: "stale_claim" },
        );
      }
      return reply.status(204).send();
    },
  );
}
