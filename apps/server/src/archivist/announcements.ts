import { requireArchiveAccess } from "./access.js";
import type { Actor, ArchivistContext } from "./context.js";
import { discordId, timestamp } from "./fields.js";

/**
 * Upload announcements. Each archive may have one destination channel, set
 * by any member and kept in the operational database. Every newly created
 * artifact is announced there once, from Discord or the web. Announcements
 * are upload history: edits and deletions never change or remove them, and
 * saving an artifact never depends on its announcement.
 *
 * The Discord bot posts them. A new artifact's post waits in a queue until
 * the bot claims it, which marks it pending, and the bot then reports how the
 * post went. Delivery state prevents a second post for the same artifact. A
 * post that definitely failed may be retried. A post whose outcome is
 * unknown, such as a timeout after sending or a claim the bot never reported
 * on, is never resent automatically, because it may already be in the
 * channel.
 */

export interface AnnouncementChannel {
  guildId: string;
  channelId: string;
}

export type DeliveryState = "pending" | "sent" | "failed" | "indeterminate";

export function getAnnouncementChannel(
  context: ArchivistContext,
  archiveId: string,
): AnnouncementChannel | null {
  return (
    (context.botDb
      .prepare(
        "SELECT guild_id AS guildId, channel_id AS channelId FROM archivist_announcement_channels WHERE archive_id = ?",
      )
      .get(archiveId) as AnnouncementChannel | undefined) ?? null
  );
}

/** Sets where new artifacts are announced. Adapters check channel permissions first. */
export function setAnnouncementChannel(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; guildId: unknown; channelId: unknown },
): AnnouncementChannel {
  const archive = requireArchiveAccess(context, actor, input.archiveId);
  const guildId = discordId("guildId", input.guildId);
  const channelId = discordId("channelId", input.channelId);
  context.botDb
    .prepare(
      `INSERT INTO archivist_announcement_channels (archive_id, guild_id, channel_id, configured_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (archive_id) DO UPDATE SET guild_id = excluded.guild_id, channel_id = excluded.channel_id,
         configured_by = excluded.configured_by, updated_at = excluded.updated_at`,
    )
    .run(archive.archiveId, guildId, channelId, actor.userId, timestamp(context.now()));
  return { guildId, channelId };
}

/** Stops future announcements. Earlier posts stay where they are. */
export function removeAnnouncementChannel(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown },
): { removed: boolean } {
  const archive = requireArchiveAccess(context, actor, input.archiveId);
  const result = context.botDb
    .prepare("DELETE FROM archivist_announcement_channels WHERE archive_id = ?")
    .run(archive.archiveId);
  return { removed: result.changes > 0 };
}

export function deliveryState(
  context: ArchivistContext,
  archiveId: string,
  artifactId: string,
): DeliveryState | null {
  const row = context.botDb
    .prepare("SELECT state FROM archivist_announcements WHERE archive_id = ? AND artifact_id = ?")
    .get(archiveId, artifactId) as { state: DeliveryState } | undefined;
  return row?.state ?? null;
}

/**
 * Claims the right to post an artifact's announcement. Returns false when it
 * was already posted, is being posted, or may have been posted. A definite
 * earlier failure can be claimed again.
 */
export function claimAnnouncement(
  context: ArchivistContext,
  input: { archiveId: string; artifactId: string } & AnnouncementChannel,
): boolean {
  const now = timestamp(context.now());
  return context.botDb.transaction(() => {
    const state = deliveryState(context, input.archiveId, input.artifactId);
    if (state !== null && state !== "failed") return false;
    context.botDb
      .prepare(
        `INSERT INTO archivist_announcements (archive_id, artifact_id, guild_id, channel_id, state, attempted_at)
         VALUES (?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (archive_id, artifact_id) DO UPDATE SET guild_id = excluded.guild_id,
           channel_id = excluded.channel_id, state = 'pending', attempted_at = excluded.attempted_at,
           message_id = NULL, error_code = NULL`,
      )
      .run(input.archiveId, input.artifactId, input.guildId, input.channelId, now);
    return true;
  })();
}

export function finishAnnouncement(
  context: ArchivistContext,
  input: {
    archiveId: string;
    artifactId: string;
    state: Exclude<DeliveryState, "pending">;
    messageId?: string;
    errorCode?: string;
  },
): void {
  context.botDb
    .prepare(
      `UPDATE archivist_announcements SET state = ?, message_id = ?, error_code = ?
       WHERE archive_id = ? AND artifact_id = ?`,
    )
    .run(
      input.state,
      input.messageId ?? null,
      input.errorCode ?? null,
      input.archiveId,
      input.artifactId,
    );
}

/**
 * Marks posts still pending as indeterminate. Run at startup: a pending post
 * means the bot stopped mid-send, so the message may or may not exist.
 */
export function settleInterruptedAnnouncements(context: ArchivistContext): number {
  return context.botDb
    .prepare("UPDATE archivist_announcements SET state = 'indeterminate' WHERE state = 'pending'")
    .run().changes;
}

/** How long the bot has to report on a claimed post before it counts as indeterminate. */
export const CLAIM_LEASE_MS = 10 * 60_000;

export type QueueOutcome = "queued" | "not_configured" | "already_handled";

/**
 * Queues a new artifact's post in the archive's current logs channel, for the
 * bot to claim. Without a channel, nothing is queued.
 */
export function queueAnnouncement(
  context: ArchivistContext,
  input: { archiveId: string; artifactId: string },
): QueueOutcome {
  const channel = getAnnouncementChannel(context, input.archiveId);
  if (!channel) return "not_configured";
  if (deliveryState(context, input.archiveId, input.artifactId) !== null) return "already_handled";
  context.botDb
    .prepare(
      `INSERT OR IGNORE INTO archivist_announcement_queue (archive_id, artifact_id, guild_id, channel_id, queued_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.archiveId,
      input.artifactId,
      channel.guildId,
      channel.channelId,
      timestamp(context.now()),
    );
  return "queued";
}

export interface ClaimedAnnouncement extends AnnouncementChannel {
  archiveId: string;
  artifactId: string;
}

/**
 * Claims queued posts for the bot, oldest first. Each leaves the queue and
 * becomes pending, so it is handed out once. An archive and artifact narrow
 * the claim, such as to the artifact the bot has just submitted.
 */
export function claimQueuedAnnouncements(
  context: ArchivistContext,
  input: { archiveId?: string | null; artifactId?: string | null; limit: number },
): ClaimedAnnouncement[] {
  const db = context.botDb;
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT archive_id AS archiveId, artifact_id AS artifactId, guild_id AS guildId, channel_id AS channelId
         FROM archivist_announcement_queue
         WHERE (@archiveId IS NULL OR archive_id = @archiveId)
           AND (@artifactId IS NULL OR artifact_id = @artifactId)
         ORDER BY queued_at, archive_id, artifact_id LIMIT @limit`,
      )
      .all({
        archiveId: input.archiveId ?? null,
        artifactId: input.artifactId ?? null,
        limit: input.limit,
      }) as ClaimedAnnouncement[];
    const dequeue = db.prepare(
      "DELETE FROM archivist_announcement_queue WHERE archive_id = ? AND artifact_id = ?",
    );
    const claimed: ClaimedAnnouncement[] = [];
    for (const row of rows) {
      dequeue.run(row.archiveId, row.artifactId);
      if (claimAnnouncement(context, row)) claimed.push(row);
    }
    return claimed;
  })();
}

/**
 * Records how a claimed post went. A report that arrives after the claim
 * expired still replaces the indeterminate state, since the bot knows better.
 * Returns false when the artifact's post was not claimed.
 */
export function reportAnnouncement(
  context: ArchivistContext,
  input: {
    archiveId: string;
    artifactId: string;
    state: Exclude<DeliveryState, "pending">;
    messageId?: string;
    errorCode?: string;
  },
): boolean {
  const current = deliveryState(context, input.archiveId, input.artifactId);
  if (current !== "pending" && current !== "indeterminate") return false;
  finishAnnouncement(context, input);
  return true;
}

/**
 * Marks claims the bot has not reported on within the lease as
 * indeterminate, because the bot may have posted before it stopped. Returns
 * how many were marked.
 */
export function settleExpiredClaims(context: ArchivistContext, leaseMs = CLAIM_LEASE_MS): number {
  const cutoff = timestamp(new Date(context.now().getTime() - leaseMs));
  return context.botDb
    .prepare(
      `UPDATE archivist_announcements SET state = 'indeterminate', error_code = 'claim_expired'
       WHERE state = 'pending' AND attempted_at < ?`,
    )
    .run(cutoff).changes;
}
