import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ArchivistContext } from "../archivist/context.js";
import {
  assertEntityDeletable,
  type EntityKind,
  entityKindValue,
  getEntity,
} from "../archivist/entities.js";
import { ArchivistError } from "../archivist/errors.js";
import { assertEventDeletable } from "../archivist/events.js";
import {
  characterNames,
  resolveCharacters,
  resolveEvents,
  resolveShortId,
  suggestCharacters,
} from "../archivist/lookup.js";
import { resolveArchiveSelection } from "../archivist/preferences.js";
import { openForActor } from "../archivist/records.js";
import {
  searchArtifacts,
  searchEntities,
  searchEvents,
  searchRequests,
  type SearchHit,
} from "../archivist/search.js";
import type { Auth } from "../archivist/web/auth.js";

/**
 * Routes the Discord commands need beyond the website's: the archive a
 * command uses when none is given, picking records by typed names and short
 * IDs for autocomplete, the short summaries embeds show, and checking whether
 * a delete would be refused before asking to confirm it. Browsers may use
 * them too. Each checks the caller's access like every archive route.
 */

type Query = Record<string, unknown>;
type ArchiveParams = { archiveId: string };

const DEFAULT_LOOKUP_LIMIT = 25;
const MAX_LOOKUP_LIMIT = 100;
const MAX_TYPED_LENGTH = 200;
const SEARCH_KINDS = [
  "artifact",
  "character",
  "account",
  "server",
  "channel",
  "event",
  "request",
] as const;
type SearchKind = (typeof SEARCH_KINDS)[number];

const TABLES: Record<EntityKind, "characters" | "accounts" | "servers" | "channels"> = {
  character: "characters",
  account: "accounts",
  server: "servers",
  channel: "channels",
};

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ArchivistError("invalid_input", "Send the fields as a JSON object.");
  }
  return body as Record<string, unknown>;
}

function typedText(field: string, value: unknown): string {
  const text = value === undefined ? "" : String(value);
  if (text.length > MAX_TYPED_LENGTH) {
    throw new ArchivistError("invalid_input", `${field} can be at most 200 characters.`, {
      field,
    });
  }
  return text;
}

function lookupLimit(value: unknown): number {
  if (value === undefined || value === "") return DEFAULT_LOOKUP_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOOKUP_LIMIT) {
    throw new ArchivistError("invalid_input", "limit must be a whole number from 1 to 100.", {
      field: "limit",
    });
  }
  return limit;
}

/** A query value given once or repeated, as a list. */
function listOf(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
}

function entityKindOf(value: string): EntityKind {
  try {
    return entityKindValue(value);
  } catch {
    throw new ArchivistError("not_found", "There is nothing at that address.");
  }
}

function search(
  db: Parameters<typeof searchArtifacts>[0],
  kind: SearchKind,
  typed: string,
  limit: number,
): SearchHit[] {
  if (kind === "artifact") return searchArtifacts(db, typed, limit);
  if (kind === "event") return searchEvents(db, typed, limit);
  if (kind === "request") return searchRequests(db, typed, limit);
  return searchEntities(db, kind, typed, limit);
}

export function registerBotRoutes(
  scope: FastifyInstance,
  context: ArchivistContext,
  auth: Auth,
): void {
  const base = "/api/archives/:archiveId";
  const actorOf = async (request: FastifyRequest) => (await auth.requireActor(request)).actor;

  /**
   * The archive a Discord command uses. An archive given here is checked and
   * remembered. Without one, the last remembered archive is used while the
   * contributor can still open it. Otherwise they are asked to choose.
   */
  scope.post("/api/me/archive-selection", async (request) =>
    resolveArchiveSelection(context, await actorOf(request), bodyOf(request).archiveId),
  );

  /** Characters named in a comma-separated list, as Discord's `characters` option takes them. */
  scope.get<{ Params: ArchiveParams; Querystring: Query }>(
    `${base}/lookup/characters`,
    async (request) => {
      const { store } = openForActor(context, await actorOf(request), request.params.archiveId);
      const ids = resolveCharacters(store.db, typedText("names", request.query.names));
      const names = characterNames(store.db, ids);
      return { characters: ids.map((id, index) => ({ id, knownName: names[index]! })) };
    },
  );

  /** Events named by title or short ID in a comma-separated list. */
  scope.get<{ Params: ArchiveParams; Querystring: Query }>(
    `${base}/lookup/events`,
    async (request) => {
      const { store } = openForActor(context, await actorOf(request), request.params.archiveId);
      const ids = resolveEvents(store.db, typedText("names", request.query.names));
      const title = store.db.prepare("SELECT title FROM events WHERE id = ?");
      return {
        events: ids.map((id) => ({ id, title: (title.get(id) as { title: string }).title })),
      };
    },
  );

  /** Completions for the last name typed in a comma-separated list of characters. */
  scope.get<{ Params: ArchiveParams; Querystring: Query }>(
    `${base}/lookup/character-suggestions`,
    async (request) => {
      const { store } = openForActor(context, await actorOf(request), request.params.archiveId);
      return { suggestions: suggestCharacters(store.db, typedText("typed", request.query.typed)) };
    },
  );

  /** The first records of one kind whose name, text, or ID matches what was typed. */
  scope.get<{ Params: ArchiveParams; Querystring: Query }>(
    `${base}/lookup/search`,
    async (request) => {
      const kind = request.query.kind as SearchKind;
      if (!SEARCH_KINDS.includes(kind)) {
        throw new ArchivistError(
          "invalid_input",
          `kind must be one of ${SEARCH_KINDS.join(", ")}.`,
          { field: "kind" },
        );
      }
      const { store } = openForActor(context, await actorOf(request), request.params.archiveId);
      return {
        items: search(
          store.db,
          kind,
          typedText("q", request.query.q),
          lookupLimit(request.query.limit),
        ),
      };
    },
  );

  /** The names embeds show for linked characters and events, keyed by ID. */
  scope.get<{ Params: ArchiveParams; Querystring: Query }>(
    `${base}/lookup/names`,
    async (request) => {
      const { store } = openForActor(context, await actorOf(request), request.params.archiveId);
      const characters = listOf(request.query.character);
      const events = listOf(request.query.event);
      if (characters.length + events.length > MAX_LOOKUP_LIMIT) {
        throw new ArchivistError("invalid_input", "Ask for at most 100 names at a time.", {
          field: "character",
        });
      }
      // An ID that names nothing in this archive maps to null.
      const name = store.db.prepare("SELECT known_name AS text FROM characters WHERE id = ?");
      const title = store.db.prepare("SELECT title AS text FROM events WHERE id = ?");
      const textOf = (statement: typeof name, id: string) =>
        (statement.get(id) as { text: string } | undefined)?.text ?? null;
      return {
        characters: Object.fromEntries(characters.map((id) => [id, textOf(name, id)])),
        events: Object.fromEntries(events.map((id) => [id, textOf(title, id)])),
      };
    },
  );

  /** A record's own fields as labeled values, the way Discord replies show them. */
  scope.get<{ Params: ArchiveParams & { kind: string; id: string } }>(
    `${base}/entities/:kind/:id/summary`,
    async (request) =>
      getEntity(context, await actorOf(request), {
        archiveId: request.params.archiveId,
        kind: entityKindOf(request.params.kind),
        id: request.params.id,
      }),
  );

  /**
   * Whether deleting the record would be refused, so an interface can refuse
   * before offering to confirm. A blocked delete answers `409` with what
   * still links to the record, as the delete itself would.
   */
  scope.get<{ Params: ArchiveParams & { kind: string; id: string } }>(
    `${base}/entities/:kind/:id/deletion-check`,
    async (request) => {
      const { store } = openForActor(context, await actorOf(request), request.params.archiveId);
      const kind = entityKindOf(request.params.kind);
      const id = resolveShortId(store.db, TABLES[kind], request.params.id, kind);
      assertEntityDeletable(store.db, kind, id);
      return { id, deletable: true };
    },
  );

  scope.get<{ Params: ArchiveParams & { id: string } }>(
    `${base}/events/:id/deletion-check`,
    async (request) => {
      const { store } = openForActor(context, await actorOf(request), request.params.archiveId);
      const id = resolveShortId(store.db, "events", request.params.id, "event");
      assertEventDeletable(store.db, id);
      return { id, deletable: true };
    },
  );
}
