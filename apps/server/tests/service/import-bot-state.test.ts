import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { ArchivistError } from "../../src/archivist/errors.js";
import { OPERATIONAL_MIGRATIONS } from "../../src/archivist/migrations/operational-schema.js";
import { archiveFolder } from "../../src/archivist/paths.js";
import { importBotState } from "../../src/service/import-bot-state.js";
import { makeArchivist, MEMBER, OWNER } from "../archivist/helpers/context.js";
import { makeTempDir } from "../archivist/helpers/temp-dir.js";

/**
 * The one-time copy of Archivist's operational rows from the bot's
 * `guhbot.db`, against a bot database at the last schema the bot had.
 */

const PRESENT = "11111111-1111-4111-8111-111111111111";
const MISSING = "22222222-2222-4222-8222-222222222222";
const CLASH = "33333333-3333-4333-8333-333333333333";
const SERVICE_CLASH = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_SENT = "aaaaaaaa-0000-4000-8000-000000000001";
const ARTIFACT_PENDING = "aaaaaaaa-0000-4000-8000-000000000002";
const AT = "2026-11-20T10:00:00.000Z";

/** The bot's operational schema version when Archivist moved out of it. */
const BOT_SCHEMA_VERSION = 3;

function archiveRow(id: string, name: string) {
  return {
    archive_id: id,
    name,
    name_key: name.toLowerCase(),
    relative_path: `archives/${id}`,
    registered_at: AT,
    registered_by: OWNER.userId,
  };
}

/** A bot database with Archivist rows of every kind, sessions, and an AFK row. */
function botDatabase(t: TestContext, version = BOT_SCHEMA_VERSION): string {
  const file = join(makeTempDir(t), "guhbot.db");
  const db = new Database(file);
  try {
    for (const migration of OPERATIONAL_MIGRATIONS.filter((m) => m.version <= version)) {
      db.exec(migration.sql);
    }
    db.prepare("INSERT OR REPLACE INTO archivist_schema (singleton, version) VALUES (1, ?)").run(
      version,
    );
    db.exec(
      "CREATE TABLE afk (user_id TEXT PRIMARY KEY, reason TEXT NOT NULL, mentions INTEGER NOT NULL DEFAULT 0)",
    );
    db.prepare("INSERT INTO afk (user_id, reason) VALUES (?, ?)").run(MEMBER.userId, "lunch");
    const insertArchive = db.prepare(
      "INSERT INTO archivist_archives (archive_id, name, name_key, relative_path, registered_at, registered_by) VALUES (@archive_id, @name, @name_key, @relative_path, @registered_at, @registered_by)",
    );
    insertArchive.run(archiveRow(PRESENT, "Test History"));
    insertArchive.run(archiveRow(MISSING, "Old Friends"));
    insertArchive.run(archiveRow(CLASH, "Clash History"));
    const whitelist = db.prepare(
      "INSERT INTO archivist_whitelist (archive_id, discord_user_id, granted_at, granted_by) VALUES (?, ?, ?, ?)",
    );
    whitelist.run(PRESENT, MEMBER.userId, AT, OWNER.userId);
    whitelist.run(CLASH, MEMBER.userId, AT, OWNER.userId);
    db.prepare(
      "INSERT INTO archivist_timezones (discord_user_id, timezone, updated_at) VALUES (?, ?, ?)",
    ).run(MEMBER.userId, "America/Toronto", AT);
    db.prepare(
      "INSERT INTO archivist_date_orders (discord_user_id, date_order, updated_at) VALUES (?, ?, ?)",
    ).run(MEMBER.userId, "dmy", AT);
    db.prepare(
      "INSERT INTO archivist_last_archives (discord_user_id, archive_id, updated_at) VALUES (?, ?, ?)",
    ).run(MEMBER.userId, PRESENT, AT);
    db.prepare(
      "INSERT INTO archivist_announcement_channels (archive_id, guild_id, channel_id, configured_by, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(PRESENT, "727573539904815224", "900000000000000111", OWNER.userId, AT);
    const announcement = db.prepare(
      "INSERT INTO archivist_announcements (archive_id, artifact_id, guild_id, channel_id, message_id, state, attempted_at, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    );
    announcement.run(
      PRESENT,
      ARTIFACT_SENT,
      "727573539904815224",
      "900000000000000111",
      "1",
      "sent",
      AT,
    );
    announcement.run(
      PRESENT,
      ARTIFACT_PENDING,
      "727573539904815224",
      "900000000000000111",
      null,
      "pending",
      AT,
    );
    const job = db.prepare(
      "INSERT INTO archivist_export_jobs (id, archive_id, requested_by, state, created_ms, expires_ms, relative_path, error_code) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)",
    );
    job.run("job-ready", PRESENT, OWNER.userId, "ready", 1, "test-history.zip");
    job.run("job-running", PRESENT, OWNER.userId, "running", 2, "test-history-2.zip");
    db.prepare(
      "INSERT INTO archivist_sessions (token_hash, discord_user_id, created_ms, expires_ms, is_owner) VALUES (?, ?, ?, ?, 0)",
    ).run("hash", MEMBER.userId, 1, 2);
    db.prepare("INSERT INTO archivist_auth_states (token_hash, expires_ms) VALUES (?, ?)").run(
      "state",
      2,
    );
  } finally {
    db.close();
  }
  return file;
}

const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function rows(db: Database.Database, sql: string, ...params: unknown[]) {
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

test("the import copies Archivist's rows, settles interrupted work, and leaves the bot database unchanged", (t) => {
  const { context } = makeArchivist(t);
  const source = botDatabase(t);
  const before = digest(source);
  const target = context.botDb;
  // The service already has an archive with the same name as one of the bot's, and its own date order for the member.
  target
    .prepare(
      "INSERT INTO archivist_archives (archive_id, name, name_key, relative_path, registered_at, registered_by) VALUES (@archive_id, @name, @name_key, @relative_path, @registered_at, @registered_by)",
    )
    .run(archiveRow(SERVICE_CLASH, "Clash History"));
  target
    .prepare(
      "INSERT INTO archivist_date_orders (discord_user_id, date_order, updated_at) VALUES (?, ?, ?)",
    )
    .run(MEMBER.userId, "mdy", AT);
  // Only one archive's folder has been copied over.
  mkdirSync(archiveFolder(context.paths, PRESENT), { recursive: true });
  writeFileSync(join(archiveFolder(context.paths, PRESENT), "archive.db"), "");

  const summary = importBotState(context, source);

  assert.deepEqual(summary.copied, {
    archivist_archives: 2,
    archivist_whitelist: 1,
    archivist_timezones: 1,
    archivist_last_archives: 1,
    archivist_announcement_channels: 1,
    archivist_announcements: 2,
    archivist_export_jobs: 2,
  });
  assert.deepEqual(summary.kept, { archivist_date_orders: 1 });
  assert.deepEqual(summary.nameConflicts, [{ archiveId: CLASH, name: "Clash History" }]);
  assert.deepEqual(summary.missingFolders, [MISSING]);

  // The service's own value was kept, not overwritten.
  assert.deepEqual(rows(target, "SELECT date_order FROM archivist_date_orders"), [
    { date_order: "mdy" },
  ]);
  // Nothing of the skipped archive came across.
  assert.deepEqual(rows(target, "SELECT archive_id FROM archivist_whitelist ORDER BY archive_id"), [
    { archive_id: PRESENT },
  ]);
  // A post the bot was sending may or may not have gone out, so it is never resent.
  assert.deepEqual(
    rows(target, "SELECT artifact_id, state FROM archivist_announcements ORDER BY artifact_id"),
    [
      { artifact_id: ARTIFACT_SENT, state: "sent" },
      { artifact_id: ARTIFACT_PENDING, state: "indeterminate" },
    ],
  );
  // An export the bot was writing is failed, and its partial zip is not claimed.
  assert.deepEqual(
    rows(
      target,
      "SELECT id, state, relative_path, error_code FROM archivist_export_jobs ORDER BY id",
    ),
    [
      { id: "job-ready", state: "ready", relative_path: "test-history.zip", error_code: null },
      { id: "job-running", state: "failed", relative_path: null, error_code: "interrupted" },
    ],
  );
  // Everyone signs in again, and AFK stays with the bot.
  assert.deepEqual(rows(target, "SELECT count(*) AS n FROM archivist_sessions"), [{ n: 0 }]);
  assert.deepEqual(rows(target, "SELECT count(*) AS n FROM archivist_auth_states"), [{ n: 0 }]);
  assert.deepEqual(
    rows(target, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'afk'"),
    [],
  );
  assert.equal(digest(source), before);

  // Running it again copies nothing and changes nothing.
  const again = importBotState(context, source);
  assert.deepEqual(again.copied, {});
  assert.deepEqual(again.kept, {
    archivist_archives: 2,
    archivist_whitelist: 1,
    archivist_timezones: 1,
    archivist_date_orders: 1,
    archivist_last_archives: 1,
    archivist_announcement_channels: 1,
    archivist_announcements: 2,
    archivist_export_jobs: 2,
  });
  assert.deepEqual(again.nameConflicts, summary.nameConflicts);
  assert.equal(digest(source), before);
});

test("the import refuses a missing file, a database without Archivist, and a newer schema", (t) => {
  const { context } = makeArchivist(t);
  const refusal = (file: string) => {
    try {
      importBotState(context, file);
    } catch (error) {
      assert.ok(error instanceof ArchivistError);
      return { code: error.code, reason: error.details.reason };
    }
    assert.fail("The import should have been refused.");
  };

  assert.deepEqual(refusal(join(makeTempDir(t), "nothing.db")), {
    code: "invalid_input",
    reason: "missing_file",
  });

  const plain = join(makeTempDir(t), "guhbot.db");
  const db = new Database(plain);
  db.exec("CREATE TABLE afk (user_id TEXT PRIMARY KEY)");
  db.close();
  assert.deepEqual(refusal(plain), { code: "invalid_input", reason: "no_archivist_tables" });

  const newer = botDatabase(t);
  const edit = new Database(newer);
  edit.prepare("UPDATE archivist_schema SET version = 99").run();
  edit.close();
  assert.deepEqual(refusal(newer), { code: "unsupported_schema", reason: undefined });

  // None of the refusals copied anything.
  assert.deepEqual(rows(context.botDb, "SELECT count(*) AS n FROM archivist_archives"), [{ n: 0 }]);
});

test("an import from the bot's last schema and from the current one copy the same rows", (t) => {
  const old = makeArchivist(t);
  const current = makeArchivist(t);
  const fromOld = importBotState(old.context, botDatabase(t));
  const fromCurrent = importBotState(
    current.context,
    botDatabase(t, OPERATIONAL_MIGRATIONS.at(-1)!.version),
  );
  assert.deepEqual(fromCurrent.copied, fromOld.copied);
  assert.deepEqual(
    rows(current.context.botDb, "SELECT archive_id, discord_user_id FROM archivist_whitelist"),
    rows(old.context.botDb, "SELECT archive_id, discord_user_id FROM archivist_whitelist"),
  );
});
