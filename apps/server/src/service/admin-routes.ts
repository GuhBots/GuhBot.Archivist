import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createArchive,
  registerArchive,
  renameArchive,
  unregisterArchive,
  updateArchiveSettings,
} from "../archivist/archives.js";
import type { ArchivistContext } from "../archivist/context.js";
import { ArchivistError } from "../archivist/errors.js";
import { exportStatus, listExports, startExport } from "../archivist/exports.js";
import { addMember, listMembers, removeMember } from "../archivist/members.js";
import type { Auth } from "../archivist/web/auth.js";

/**
 * The owner's administration: archives, whitelists, and exports. These are
 * the operations `/archivist-admin` runs in Discord, and the bot reaches them
 * here with the owner as the acting user. The shared operations refuse
 * anyone but an owner, so a member sees `403` on an archive they can open and
 * `404` on one they cannot.
 */

type ArchiveParams = { archiveId: string };

const DEFAULT_EXPORT_LIST = 10;
const MAX_EXPORT_LIST = 50;

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ArchivistError("invalid_input", "Send the fields as a JSON object.");
  }
  return body as Record<string, unknown>;
}

function exportListLimit(value: unknown): number {
  if (value === undefined || value === "") return DEFAULT_EXPORT_LIST;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXPORT_LIST) {
    throw new ArchivistError("invalid_input", "limit must be a whole number from 1 to 50.", {
      field: "limit",
    });
  }
  return limit;
}

export function registerAdminRoutes(
  scope: FastifyInstance,
  context: ArchivistContext,
  auth: Auth,
  logError: (message: string, error: unknown) => void,
): void {
  const actorOf = async (request: FastifyRequest) => (await auth.requireActor(request)).actor;

  /* Archives */

  scope.post("/api/archives", async (request, reply) => {
    const archive = createArchive(context, await actorOf(request), { name: bodyOf(request).name });
    return reply.status(201).send(archive);
  });

  // Hosts an archive folder already copied under the data directory's archives folder.
  scope.post("/api/archives/register", async (request, reply) => {
    const body = bodyOf(request);
    const result = registerArchive(context, await actorOf(request), {
      archiveId: body.archiveId,
      name: body.name,
    });
    return reply.status(201).send(result);
  });

  scope.put<{ Params: ArchiveParams }>("/api/archives/:archiveId/name", async (request) => {
    const body = bodyOf(request);
    return renameArchive(context, await actorOf(request), {
      archiveId: request.params.archiveId,
      name: body.name,
      expectedVersion: body.expectedVersion,
    });
  });

  scope.patch<{ Params: ArchiveParams }>("/api/archives/:archiveId/settings", async (request) => {
    const body = bodyOf(request);
    return updateArchiveSettings(context, await actorOf(request), {
      archiveId: request.params.archiveId,
      expectedVersion: body.expectedVersion,
      timezone: body.timezone,
      mainServerId: body.mainServerId,
      laneGapDays: body.laneGapDays,
      colors: body.colors,
    });
  });

  // Stops hosting the archive. Its folder and files stay where they are.
  scope.delete<{ Params: ArchiveParams }>("/api/archives/:archiveId", async (request, reply) => {
    unregisterArchive(context, await actorOf(request), { archiveId: request.params.archiveId });
    return reply.status(204).send();
  });

  /* Whitelists */

  scope.get<{ Params: ArchiveParams }>("/api/archives/:archiveId/members", async (request) => ({
    members: listMembers(context, await actorOf(request), {
      archiveId: request.params.archiveId,
    }),
  }));

  scope.put<{ Params: ArchiveParams & { userId: string } }>(
    "/api/archives/:archiveId/members/:userId",
    async (request) => addMember(context, await actorOf(request), request.params),
  );

  scope.delete<{ Params: ArchiveParams & { userId: string } }>(
    "/api/archives/:archiveId/members/:userId",
    async (request) => removeMember(context, await actorOf(request), request.params),
  );

  /* Exports */

  /**
   * Starts an export and answers once the snapshot is taken. The zip is
   * written on the service's host, and `GET /api/exports/:jobId` reports
   * when it is ready. Nothing is sent over the network.
   */
  scope.post<{ Params: ArchiveParams }>(
    "/api/archives/:archiveId/exports",
    async (request, reply) => {
      const started = startExport(context, await actorOf(request), {
        archiveId: request.params.archiveId,
      });
      // The job records a failure itself. This only keeps it from going unnoticed in the log.
      started.done.catch((error: unknown) => logError("An export failed", error));
      return reply.status(202).send(started.job);
    },
  );

  scope.get<{ Querystring: Record<string, unknown> }>("/api/exports", async (request) => ({
    exports: listExports(context, await actorOf(request), exportListLimit(request.query.limit)),
  }));

  scope.get<{ Params: { jobId: string } }>("/api/exports/:jobId", async (request) =>
    exportStatus(context, await actorOf(request), { jobId: request.params.jobId }),
  );
}
