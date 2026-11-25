import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { ArchivistError } from "../../src/archivist/errors.js";
import { closeMetadataReader } from "../../src/archivist/metadata.js";
import type { ServiceConfig } from "../../src/service/config.js";
import { OPERATIONAL_DATABASE, openOperationalDatabase, serve } from "../../src/service/server.js";
import { prepareOperationalDatabase } from "../../src/archivist/operational-database.js";
import { makeTempDir } from "../archivist/helpers/temp-dir.js";
import { MEMBER, OWNER, SERVICE_TOKEN, testConfig } from "./harness.js";

/**
 * `serve` as the container runs it: a real listener on a local port, the
 * operational database in the data directory, and the checks at start.
 */

after(() => closeMetadataReader());

function quietLog() {
  const lines: { level: "warn" | "error"; text: string }[] = [];
  return {
    lines,
    log: {
      warn: (...args: unknown[]) => lines.push({ level: "warn", text: args.join(" ") }),
      error: (...args: unknown[]) => lines.push({ level: "error", text: args.join(" ") }),
    },
  };
}

function config(t: TestContext, overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  const dataDir = makeTempDir(t);
  return testConfig(dataDir, { frontendRoot: makeTempDir(t), ...overrides });
}

test("the service starts, answers its health check and the bot, and stops cleanly", async (t) => {
  const settings = config(t);
  const { lines, log } = quietLog();
  const service = await serve({ config: settings, log });
  let closed = false;
  t.after(async () => {
    if (!closed) await service.close();
  });
  const status = service.status();
  assert.equal(status.running, true);
  const base = `http://127.0.0.1:${status.listening!.port}`;

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  // The bot's credential works over a real socket, and owners come from the settings.
  const me = await fetch(`${base}/api/me`, {
    headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "x-archivist-user": OWNER.userId },
  });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as { isOwner: boolean }).isOwner, true);
  const member = await fetch(`${base}/api/me`, {
    headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "x-archivist-user": MEMBER.userId },
  });
  assert.equal(((await member.json()) as { isOwner: boolean }).isOwner, false);

  // The operational database lives in the data directory, in WAL mode.
  const file = join(settings.dataDir, OPERATIONAL_DATABASE);
  assert.ok(existsSync(file));
  assert.equal(service.context.botDb.pragma("journal_mode", { simple: true }), "wal");
  assert.deepEqual(lines, []);

  await service.close();
  closed = true;
  assert.equal(service.status().running, false);
  await assert.rejects(fetch(`${base}/api/health`));
  // Everything was closed, so the database opens again at once.
  const reopened = openOperationalDatabase(settings.dataDir);
  reopened.close();
});

test("the service refuses to start without owners or with a short token, before touching the data directory", async (t) => {
  const noOwners = config(t, { ownerIds: new Set() });
  await assert.rejects(serve({ config: noOwners, log: quietLog().log }), (error: unknown) => {
    assert.ok(error instanceof ArchivistError);
    assert.equal(error.details.reason, "missing_owner_ids");
    return true;
  });
  assert.equal(existsSync(join(noOwners.dataDir, OPERATIONAL_DATABASE)), false);

  const shortToken = config(t, { serviceToken: "too-short" });
  await assert.rejects(serve({ config: shortToken, log: quietLog().log }), (error: unknown) => {
    assert.ok(error instanceof ArchivistError);
    assert.equal(error.details.reason, "short_service_token");
    return true;
  });
});

test("without a service token the website still starts, and the service says the bot cannot connect", async (t) => {
  const settings = config(t, { serviceToken: null });
  const { lines, log } = quietLog();
  const service = await serve({ config: settings, log });
  t.after(() => service.close());
  assert.deepEqual(
    lines.map((line) => line.level),
    ["warn"],
  );
  assert.match(lines[0]!.text, /ARCHIVIST_SERVICE_TOKEN is not set/);
  const base = `http://127.0.0.1:${service.status().listening!.port}`;
  const refused = await fetch(`${base}/api/me`, {
    headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "x-archivist-user": OWNER.userId },
  });
  assert.equal(refused.status, 401);
});

test("a busy port stops the start with a message naming it, and leaves nothing open", async (t) => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const port = (blocker.address() as { port: number }).port;
  const settings = config(t);
  settings.web = { ...settings.web, port };

  await assert.rejects(serve({ config: settings, log: quietLog().log }), (error: unknown) => {
    assert.ok(error instanceof ArchivistError);
    assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
    return true;
  });
  // The operational database was closed again, so another start can use it.
  const reopened = new Database(join(settings.dataDir, OPERATIONAL_DATABASE));
  reopened.prepare("SELECT count(*) FROM archivist_archives").get();
  reopened.close();
});

test("exports a restart interrupted are failed when the service starts", async (t) => {
  const settings = config(t);
  const db = openOperationalDatabase(settings.dataDir);
  prepareOperationalDatabase(db);
  db.prepare(
    "INSERT INTO archivist_archives (archive_id, name, name_key, relative_path, registered_at, registered_by) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "11111111-1111-4111-8111-111111111111",
    "Test History",
    "test history",
    "archives/11111111-1111-4111-8111-111111111111",
    "2026-11-20T10:00:00.000Z",
    OWNER.userId,
  );
  db.prepare(
    "INSERT INTO archivist_export_jobs (id, archive_id, requested_by, state, created_ms, expires_ms, relative_path, error_code) VALUES (?, ?, ?, 'running', 1, NULL, ?, NULL)",
  ).run("job-running", "11111111-1111-4111-8111-111111111111", OWNER.userId, "test-history.zip");
  db.close();

  const { lines, log } = quietLog();
  const service = await serve({ config: settings, log });
  t.after(() => service.close());
  assert.ok(lines.some((line) => /1 export\(s\) were interrupted and failed/.test(line.text)));
  assert.deepEqual(
    service.context.botDb
      .prepare("SELECT state, error_code, relative_path FROM archivist_export_jobs")
      .all(),
    [{ state: "failed", error_code: "interrupted", relative_path: null }],
  );
});
