import type { FastifyInstance, FastifyRequest } from "fastify";
import { registeredArchive } from "../archivist/access.js";
import {
  type ClaimedAnnouncement,
  claimQueuedAnnouncements,
  deliveryState,
  reportAnnouncement,
} from "../archivist/announcements.js";
import { archiveDetails } from "../archivist/archives.js";
import { type ArtifactDetails, readArtifact } from "../archivist/artifacts.js";
import { type ArchivistContext, openStore } from "../archivist/context.js";
import { ArchivistError } from "../archivist/errors.js";
import { discordId } from "../archivist/fields.js";
import { characterNames } from "../archivist/lookup.js";
import { archiveIdValue } from "../archivist/paths.js";
import type { ServiceAuth } from "./service-auth.js";

/**
 * The Discord bot's side of upload announcements. New artifacts wait in a
 * queue. The bot claims them, posts each one in its archive's logs channel,
 * and reports how the post went. A claim is handed out once. A claim not
 * reported within the lease becomes indeterminate and is never handed out
 * again, because the post may already be in the channel.
 */

const DEFAULT_CLAIMS = 10;
const MAX_CLAIMS = 25;
const MAX_REASON_LENGTH = 200;
const RESULT_STATES = ["sent", "failed", "indeterminate"] as const;

/** Everything the bot needs to post one artifact's announcement. */
export interface AnnouncementItem {
  archiveId: string;
  archiveName: string;
  archiveTimeZone: string;
  channel: { guildId: string; channelId: string };
  artifact: ArtifactDetails;
  /** Known names of `artifact.links.characters`, in the same order. */
  characterNames: string[];
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
      {
        field: "limit",
      },
    );
  }
  return value;
}

function artifactIdValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value)) {
    throw new ArchivistError("invalid_input", "artifactId must be a full artifact ID.", {
      field: "artifactId",
    });
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
  /** A claimed post with its artifact, or null after recording why it cannot be posted. */
  function describe(claim: ClaimedAnnouncement): AnnouncementItem | null {
    const giveUp = (errorCode: string) => {
      reportAnnouncement(context, { ...claim, state: "failed", errorCode });
      return null;
    };
    try {
      const store = openStore(context, claim.archiveId);
      const details = archiveDetails(store);
      const artifact = readArtifact(store.db, claim.artifactId);
      // Deleted before the bot claimed it, so there is nothing left to show.
      if (!artifact) return giveUp("artifact_deleted");
      return {
        archiveId: claim.archiveId,
        archiveName: registeredArchive(context, claim.archiveId)?.name ?? details.name,
        archiveTimeZone: details.timezone,
        channel: { guildId: claim.guildId, channelId: claim.channelId },
        artifact,
        characterNames: characterNames(store.db, artifact.links.characters),
        previewPath: artifact.media.hasPreview
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
      artifactId: artifactIdValue(body.artifactId),
      limit: claimLimit(body.limit),
    });
    return { items: claims.map(describe).filter((item) => item !== null) };
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

  /** How a claimed post went: sent with its message, definitely failed, or unknown. */
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
      const messageId = state === "sent" ? discordId("messageId", body.messageId) : undefined;
      const reason =
        body.reason === undefined || body.reason === null ? undefined : String(body.reason);
      if (reason !== undefined && reason.length > MAX_REASON_LENGTH) {
        throw new ArchivistError("invalid_input", "reason can be at most 200 characters.", {
          field: "reason",
        });
      }
      const recorded = reportAnnouncement(context, {
        archiveId,
        artifactId: request.params.artifactId,
        state,
        messageId,
        errorCode: reason,
      });
      if (!recorded) {
        throw new ArchivistError("not_found", "That artifact's announcement was not claimed.");
      }
      return reply.status(204).send();
    },
  );
}
