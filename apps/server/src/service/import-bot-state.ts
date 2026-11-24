import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { ArchivistContext } from "../archivist/context.js";
import { ArchivistError } from "../archivist/errors.js";
import { OPERATIONAL_SCHEMA_VERSION } from "../archivist/migrations/operational-schema.js";
import { archiveFolder } from "../archivist/paths.js";

/**
 * Copies Archivist's operational state from the bot's `guhbot.db` into the
 * service's operational database, for the move from the bot to the service:
 * the archive registry, whitelists, contributors' preferences and remembered
 * archives, logs channels, announcement history, and export history.
 *
 * Website sessions and sign-in states are not copied, so everyone signs in
 * again. Rows the service already has are kept, so running the import twice
 * changes nothing. A post the bot was sending becomes indeterminate and an
 * export it was writing becomes failed, as a bot restart would leave them.
 * The archive folders themselves are copied by hand, and the summary names
 * the ones not yet in place.
 */

export interface ImportSummary {
  /** Rows copied per table. */
  copied: Record<string, number>;
  /** Rows the service already had, per table. */
  kept: Record<string, number>;
  /** Archives not copied because the service already has another archive with the same name. */
  nameConflicts: { archiveId: string; name: string }[];
  /** Registered archives whose folder is not yet in the service's archives folder. */
  missingFolders: string[];
}

interface TableCopy {
  name: string;
  columns: string[];
  /** Rows of an archive that was not copied would break their reference, so they are left out. */
  perArchive: boolean;
  /** Adjusts a row before it is copied. */
  adjust?(row: Record<string, unknown>): Record<string, unknown>;
}

const COPIED_TABLES: TableCopy[] = [
  {
    name: "archivist_whitelist",
    columns: ["archive_id", "discord_user_id", "granted_at", "granted_by"],
    perArchive: true,
  },
  {
    name: "archivist_timezones",
    columns: ["discord_user_id", "timezone", "updated_at"],
    perArchive: false,
  },
  {
    name: "archivist_date_orders",
    columns: ["discord_user_id", "date_order", "updated_at"],
    perArchive: false,
  },
  {
    name: "archivist_last_archives",
    columns: ["discord_user_id", "archive_id", "updated_at"],
    perArchive: true,
  },
  {
    name: "archivist_announcement_channels",
    columns: ["archive_id", "guild_id", "channel_id", "configured_by", "updated_at"],
    perArchive: true,
  },
  {
    name: "archivist_announcements",
    columns: [
      "archive_id",
      "artifact_id",
      "guild_id",
      "channel_id",
      "message_id",
      "state",
      "attempted_at",
      "error_code",
    ],
    perArchive: true,
    // The bot stopped before it knew whether the post went out.
    adjust: (row) => (row.state === "pending" ? { ...row, state: "indeterminate" } : row),
  },
  {
    name: "archivist_export_jobs",
    columns: [
      "id",
      "archive_id",
      "requested_by",
      "state",
      "created_ms",
      "expires_ms",
      "relative_path",
      "error_code",
    ],
    perArchive: true,
    // Its partial zip is on the bot's host and is never finished.
    adjust: (row) =>
      row.state === "queued" || row.state === "running"
        ? { ...row, state: "failed", error_code: "interrupted", relative_path: null }
        : row,
  },
];

const ARCHIVE_COLUMNS = [
  "archive_id",
  "name",
  "name_key",
  "relative_path",
  "registered_at",
  "registered_by",
];

function operationalVersion(db: Database.Database): number {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'archivist_schema'")
    .get();
  if (!table) return 0;
  const row = db.prepare("SELECT version FROM archivist_schema").get() as
    { version: number } | undefined;
  return row?.version ?? 0;
}

function hasTable(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

export function importBotState(context: ArchivistContext, botDatabase: string): ImportSummary {
  if (!existsSync(botDatabase)) {
    throw new ArchivistError("invalid_input", `${botDatabase} does not exist.`, {
      reason: "missing_file",
    });
  }
  const source = new Database(botDatabase, { readonly: true, fileMustExist: true });
  try {
    const version = operationalVersion(source);
    if (version === 0) {
      throw new ArchivistError(
        "invalid_input",
        "That database has no Archivist tables to import.",
        {
          reason: "no_archivist_tables",
        },
      );
    }
    if (version > OPERATIONAL_SCHEMA_VERSION) {
      throw new ArchivistError(
        "unsupported_schema",
        `That database uses Archivist's operational schema version ${version}, but this service supports up to ${OPERATIONAL_SCHEMA_VERSION}. Update GuhBot.Archivist first.`,
        { schemaVersion: version, supportedVersion: OPERATIONAL_SCHEMA_VERSION },
      );
    }

    const target = context.botDb;
    const summary: ImportSummary = { copied: {}, kept: {}, nameConflicts: [], missingFolders: [] };
    const count = (bucket: Record<string, number>, table: string) => {
      bucket[table] = (bucket[table] ?? 0) + 1;
    };

    const present = new Set<string>();
    target.transaction(() => {
      // Archives first, since every other per-archive row refers to one.
      const archives = source
        .prepare(`SELECT ${ARCHIVE_COLUMNS.join(", ")} FROM archivist_archives ORDER BY archive_id`)
        .all() as Record<string, string>[];
      const byId = target.prepare("SELECT 1 FROM archivist_archives WHERE archive_id = ?");
      const byName = target.prepare(
        "SELECT 1 FROM archivist_archives WHERE name_key = ? AND archive_id <> ?",
      );
      const insertArchive = target.prepare(
        `INSERT INTO archivist_archives (${ARCHIVE_COLUMNS.join(", ")})
         VALUES (${ARCHIVE_COLUMNS.map((column) => `@${column}`).join(", ")})`,
      );
      for (const archive of archives) {
        if (byId.get(archive.archive_id)) {
          count(summary.kept, "archivist_archives");
        } else if (byName.get(archive.name_key, archive.archive_id)) {
          summary.nameConflicts.push({ archiveId: archive.archive_id!, name: archive.name! });
          continue;
        } else {
          insertArchive.run(archive);
          count(summary.copied, "archivist_archives");
        }
        present.add(archive.archive_id!);
      }

      for (const table of COPIED_TABLES) {
        if (!hasTable(source, table.name)) continue;
        const insert = target.prepare(
          `INSERT OR IGNORE INTO ${table.name} (${table.columns.join(", ")})
           VALUES (${table.columns.map((column) => `@${column}`).join(", ")})`,
        );
        const rows = source
          .prepare(`SELECT ${table.columns.join(", ")} FROM ${table.name}`)
          .all() as Record<string, unknown>[];
        for (const row of rows) {
          if (table.perArchive && !present.has(String(row.archive_id))) continue;
          const changes = insert.run(table.adjust ? table.adjust(row) : row).changes;
          count(changes > 0 ? summary.copied : summary.kept, table.name);
        }
      }
    })();

    for (const archiveId of present) {
      if (!existsSync(join(archiveFolder(context.paths, archiveId), "archive.db"))) {
        summary.missingFolders.push(archiveId);
      }
    }
    return summary;
  } finally {
    source.close();
  }
}
