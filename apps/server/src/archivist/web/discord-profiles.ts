import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Actor, ArchivistContext } from "../context.js";
import { archiveDay } from "../dates.js";
import { ArchivistError } from "../errors.js";
import { addHistory } from "../history.js";
import { createStagingFolder, discardStaging, MAX_MEDIA_BYTES, stageMedia } from "../media.js";
import { notFoundRecord, openForActor } from "../records.js";
import { resolveShortId } from "../lookup.js";
import { expectedVersionValue, staleVersion } from "../versions.js";
import { DISCORD_API, type Fetch } from "./discord-oauth.js";

/**
 * Reads a Discord account's current avatar by its Discord ID and records it
 * as an avatar observed today. Discord only shows other people's profiles
 * to bots, so this needs a bot token, `DISCORD_BOT_TOKEN`. Any bot works,
 * including one with no servers or permissions. The owner asked on
 * 2026-11-25 for avatars to come from Discord IDs, so a linked account
 * shows a picture without uploading one.
 */

const CDN = "https://cdn.discordapp.com";
const REQUEST_TIMEOUT_MS = 15_000;
/** Discord serves avatars up to 4096 pixels. 1024 is plenty for a profile picture. */
const AVATAR_SIZE = 1024;

export interface DiscordProfile {
  id: string;
  username: string;
  /** The avatar's address, or null when the account uses Discord's default avatar. */
  avatarUrl: string | null;
}

function unavailable(message: string, details: Record<string, unknown> = {}): ArchivistError {
  return new ArchivistError("dependency_unavailable", message, {
    reason: "discord_unavailable",
    ...details,
  });
}

async function call(fetchImpl: Fetch, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw unavailable("Discord did not answer. Try again in a moment.");
  }
}

/** A user's public profile, as a bot sees it. */
export async function fetchDiscordProfile(
  token: string,
  userId: string,
  fetchImpl: Fetch,
): Promise<DiscordProfile> {
  const response = await call(fetchImpl, `${DISCORD_API}/users/${userId}`, {
    headers: { authorization: `Bot ${token}` },
  });
  if (response.status === 404 || response.status === 400) {
    throw new ArchivistError("invalid_input", "Discord has no account with that ID.", {
      field: "discordId",
    });
  }
  if (response.status === 401 || response.status === 403) {
    throw unavailable("Discord refused DISCORD_BOT_TOKEN. Ask the owner to check it.", {
      status: response.status,
    });
  }
  if (response.status === 429) {
    throw unavailable("Discord asked to slow down. Try again in a minute.", { status: 429 });
  }
  if (!response.ok) throw unavailable("Discord did not answer. Try again in a moment.");
  const user = (await response.json().catch(() => null)) as {
    id?: unknown;
    username?: unknown;
    avatar?: unknown;
  } | null;
  if (user?.id !== userId || typeof user.username !== "string") {
    throw unavailable("Discord sent an answer Archivist could not read.");
  }
  const hash =
    typeof user.avatar === "string" && /^(a_)?[0-9a-f]{32}$/.test(user.avatar) ? user.avatar : null;
  return {
    id: userId,
    username: user.username,
    // Animated avatars start with a_ and are kept as GIFs, so they still move.
    avatarUrl: hash
      ? `${CDN}/avatars/${userId}/${hash}.${hash.startsWith("a_") ? "gif" : "png"}?size=${AVATAR_SIZE}`
      : null,
  };
}

async function download(fetchImpl: Fetch, url: string, file: string): Promise<void> {
  const response = await call(fetchImpl, url);
  if (!response.ok || !response.body) {
    throw unavailable("Discord did not send the avatar. Try again in a moment.");
  }
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_MEDIA_BYTES) throw unavailable("Discord sent an avatar that is too large.");
  await pipeline(
    Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
    createWriteStream(file),
  );
}

export type AvatarRefresh =
  { status: "added"; mediaId: string } | { status: "unchanged" } | { status: "default_avatar" };

/**
 * Records an account's current Discord avatar, dated today in the archive's
 * timezone. Nothing is added when it matches the account's latest avatar, or
 * when the account uses Discord's default avatar. The account's version
 * guards against someone else's edit, as any history change does.
 */
export async function refreshDiscordAvatar(
  context: ArchivistContext,
  actor: Actor,
  input: {
    archiveId: unknown;
    accountId: unknown;
    expectedVersion: unknown;
    token: string | undefined;
    fetch: Fetch;
  },
): Promise<AvatarRefresh> {
  const { store, details } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const accountId = resolveShortId(db, "accounts", input.accountId, "account");
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const account = db
    .prepare("SELECT version, discord_id AS discordId FROM accounts WHERE id = ?")
    .get(accountId) as { version: number; discordId: string | null } | undefined;
  if (!account) throw notFoundRecord("account");
  if (account.version !== expectedVersion) {
    throw staleVersion("account", accountId, account.version, {});
  }
  if (!account.discordId) {
    throw new ArchivistError("invalid_input", "Give this account its Discord ID first.", {
      field: "discordId",
    });
  }
  if (!input.token) {
    throw new ArchivistError(
      "dependency_unavailable",
      "Archivist cannot look up Discord accounts until the owner sets DISCORD_BOT_TOKEN.",
      { reason: "discord_lookups_off" },
    );
  }
  const profile = await fetchDiscordProfile(input.token, account.discordId, input.fetch);
  if (!profile.avatarUrl) return { status: "default_avatar" };

  const staging = createStagingFolder(context);
  try {
    const file = join(staging, "original");
    await download(input.fetch, profile.avatarUrl, file);
    const media = await stageMedia(context, {
      file,
      originalFilename: `${profile.username}-avatar.${profile.avatarUrl.includes(".gif") ? "gif" : "png"}`,
    });
    const latest = db
      .prepare(
        `SELECT m.sha256 FROM account_avatars v JOIN media m ON m.id = v.media_id
         LEFT JOIN date_values d ON d.id = v.observed_date_id
         WHERE v.account_id = ?
         ORDER BY d.archive_day IS NULL, d.archive_day DESC, coalesce(d.instant_ms, 0) DESC, v.id DESC
         LIMIT 1`,
      )
      .get(accountId) as { sha256: string } | undefined;
    if (latest?.sha256 === media.sha256) return { status: "unchanged" };
    const today = archiveDay(
      {
        kind: "instant",
        originalText: "",
        instantMs: context.now().getTime(),
        timezone: details.timezone,
      },
      details.timezone,
    );
    const entry = addHistory(context, actor, {
      archiveId: input.archiveId,
      kind: "avatar",
      parentId: accountId,
      expectedVersion,
      date: today,
      media,
    });
    return { status: "added", mediaId: entry.mediaId! };
  } finally {
    discardStaging(context, staging);
  }
}
