import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { LightMyRequestResponse } from "fastify";
import type { ArchiveDetails, RegisterResult } from "../../src/archivist/archives.js";
import { parseLog } from "../../src/archivist/edit-log.js";
import type { ExportJob } from "../../src/archivist/exports.js";
import type { Member } from "../../src/archivist/members.js";
import { SESSION_COOKIE } from "../../src/archivist/web/auth.js";
import { MEMBER, NOW, OTHER, OWNER, serviceHarness, type ServiceHarness } from "./harness.js";

/**
 * The owner's administration routes for archives, whitelists, and exports.
 * Most requests come from the Discord bot, with the service token and the
 * acting Discord user, as `/archivist-admin` sends them. OWNER is in the
 * service's owner list. MEMBER and OTHER are not.
 */

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Route = [method: Method, url: string, payload?: object];

/** A tiny archive's export finishes in well under a second. This only stops a hung test. */
const EXPORT_TIMEOUT_MS = 10_000;
const EXPORT_POLL_MS = 20;

/** Sends a bot request acting for a Discord user, with an optional JSON body. */
function asBot(
  h: ServiceHarness,
  userId: string,
  method: Method,
  url: string,
  payload?: object,
): Promise<LightMyRequestResponse> {
  return h.inject({
    method,
    url,
    headers: h.bot(userId),
    ...(payload === undefined ? {} : { payload }),
  });
}

/** Checks an error reply's status and code, and returns its details. The label names the request. */
function errorDetails(
  response: LightMyRequestResponse,
  status: number,
  code: string,
  label?: string,
): Record<string, unknown> {
  const message = label ? `${label} answered ${response.body}` : response.body;
  assert.equal(response.statusCode, status, message);
  const body = response.json() as { code: string; details: Record<string, unknown> };
  assert.equal(body.code, code, message);
  return body.details;
}

async function createArchive(h: ServiceHarness, name: string): Promise<ArchiveDetails> {
  const response = await asBot(h, OWNER.userId, "POST", "/api/archives", { name });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as ArchiveDetails;
}

async function getArchive(h: ServiceHarness, archiveId: string): Promise<ArchiveDetails> {
  const response = await asBot(h, OWNER.userId, "GET", `/api/archives/${archiveId}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as ArchiveDetails;
}

async function archiveNames(h: ServiceHarness): Promise<string[]> {
  const response = await asBot(h, OWNER.userId, "GET", "/api/archives");
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { archives: { name: string }[] }).archives.map(({ name }) => name);
}

async function addMember(h: ServiceHarness, archiveId: string, userId: string): Promise<void> {
  const response = await asBot(
    h,
    OWNER.userId,
    "PUT",
    `/api/archives/${archiveId}/members/${userId}`,
  );
  assert.equal(response.statusCode, 200, response.body);
}

async function listMembers(h: ServiceHarness, archiveId: string): Promise<Member[]> {
  const response = await asBot(h, OWNER.userId, "GET", `/api/archives/${archiveId}/members`);
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { members: Member[] }).members;
}

/** Records a server in the archive and returns its ID, so it can be the main server. */
async function createServer(h: ServiceHarness, archiveId: string, label: string): Promise<string> {
  const response = await asBot(
    h,
    OWNER.userId,
    "POST",
    `/api/archives/${archiveId}/entities/server`,
    { label },
  );
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { id: string }).id;
}

async function listExports(h: ServiceHarness, query = ""): Promise<ExportJob[]> {
  const response = await asBot(h, OWNER.userId, "GET", `/api/exports${query}`);
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { exports: ExportJob[] }).exports;
}

/** Polls an export until its zip is complete. Compression continues after the start reply. */
async function waitForExport(h: ServiceHarness, jobId: string): Promise<ExportJob> {
  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  for (;;) {
    const response = await asBot(h, OWNER.userId, "GET", `/api/exports/${jobId}`);
    assert.equal(response.statusCode, 200, response.body);
    const job = response.json() as ExportJob;
    if (job.state === "ready") return job;
    assert.equal(job.state, "running", `The export stopped with ${job.errorCode}.`);
    assert.ok(Date.now() < deadline, "The export was not ready in time.");
    await delay(EXPORT_POLL_MS);
  }
}

async function exportArchive(h: ServiceHarness, archiveId: string): Promise<ExportJob> {
  const response = await asBot(h, OWNER.userId, "POST", `/api/archives/${archiveId}/exports`);
  assert.equal(response.statusCode, 202, response.body);
  return waitForExport(h, (response.json() as ExportJob).id);
}

const END_OF_CENTRAL_DIRECTORY = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;

/**
 * Lists a zip's entry names from its central directory, so the test needs no
 * unzip tool. Offsets follow the zip format's end record and file headers.
 */
function zipEntries(path: string): string[] {
  const zip = readFileSync(path);
  const end = zip.lastIndexOf(END_OF_CENTRAL_DIRECTORY);
  assert.ok(end >= 0, "The zip has no central directory.");
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(zip.readUInt32LE(offset), CENTRAL_DIRECTORY_ENTRY, "A zip entry is damaged.");
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.toString("utf8", offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names.sort();
}

test("only an owner creates archives, and names are unique ignoring case", async (t) => {
  const h = await serviceHarness(t);
  const created = await asBot(h, OWNER.userId, "POST", "/api/archives", { name: "  Old Days  " });
  assert.equal(created.statusCode, 201, created.body);
  // The bot's credential never starts a browser session.
  assert.equal(created.headers["set-cookie"], undefined);
  const archive = created.json() as ArchiveDetails;
  assert.equal(archive.name, "Old Days");
  assert.equal(archive.version, 1);
  assert.equal(archive.timezone, "America/Toronto");
  assert.equal(archive.mainServerId, null);
  assert.equal(archive.createdAt, NOW.toISOString());
  const folder = join(h.context.paths.archivesRoot, archive.archiveId);
  assert.deepEqual(readdirSync(folder).sort(), ["archive.db", "edits.log", "media"]);

  // Owner status comes from the service's owner list, never from the request.
  for (const userId of [MEMBER.userId, OTHER.userId]) {
    const refused = await asBot(h, userId, "POST", "/api/archives", {
      name: "Mine",
      isOwner: true,
    });
    errorDetails(refused, 403, "forbidden");
  }
  const taken = await asBot(h, OWNER.userId, "POST", "/api/archives", { name: "OLD DAYS" });
  assert.equal(errorDetails(taken, 409, "name_taken").field, "name");
  const blank = await asBot(h, OWNER.userId, "POST", "/api/archives", { name: "   " });
  assert.equal(errorDetails(blank, 400, "invalid_input").field, "name");
  const notAnObject = await asBot(h, OWNER.userId, "POST", "/api/archives", ["Old Days"]);
  errorDetails(notAnObject, 400, "invalid_input");

  assert.deepEqual(readdirSync(h.context.paths.archivesRoot), [archive.archiveId]);
  assert.deepEqual(await archiveNames(h), ["Old Days"]);
});

test("the owner can administer archives from a signed-in browser", async (t) => {
  const h = await serviceHarness(t);
  const cookies = { [SESSION_COOKIE]: h.cookie(OWNER) };
  const created = await h.inject({
    method: "POST",
    url: "/api/archives",
    headers: { origin: h.origin },
    cookies,
    payload: { name: "From The Website" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { archiveId } = created.json() as ArchiveDetails;
  const granted = await h.inject({
    method: "PUT",
    url: `/api/archives/${archiveId}/members/${MEMBER.userId}`,
    headers: { origin: h.origin },
    cookies,
  });
  assert.equal(granted.statusCode, 200, granted.body);
  assert.deepEqual(granted.json(), { added: true });
  assert.deepEqual(
    (await listMembers(h, archiveId)).map(({ userId, grantedBy }) => ({ userId, grantedBy })),
    [{ userId: MEMBER.userId, grantedBy: OWNER.userId }],
  );

  // The owner's cookie alone does not let another site make changes.
  const forged = await h.inject({
    method: "POST",
    url: "/api/archives",
    headers: { origin: "https://elsewhere.example" },
    cookies,
    payload: { name: "Forged" },
  });
  assert.equal(errorDetails(forged, 403, "forbidden").reason, "cross_origin");
  assert.deepEqual(await archiveNames(h), ["From The Website"]);
});

test("renaming needs the version the owner last saw and never moves the folder", async (t) => {
  const h = await serviceHarness(t);
  const archive = await createArchive(h, "Before");
  await createArchive(h, "Other");
  const url = `/api/archives/${archive.archiveId}/name`;

  const unversioned = await asBot(h, OWNER.userId, "PUT", url, { name: "After" });
  assert.equal(errorDetails(unversioned, 400, "invalid_input").field, "expectedVersion");

  const renamed = await asBot(h, OWNER.userId, "PUT", url, { name: "After", expectedVersion: 1 });
  assert.equal(renamed.statusCode, 200, renamed.body);
  const details = renamed.json() as ArchiveDetails;
  assert.equal(details.archiveId, archive.archiveId);
  assert.equal(details.name, "After");
  assert.equal(details.version, 2);
  assert.ok(existsSync(join(h.context.paths.archivesRoot, archive.archiveId, "archive.db")));
  assert.deepEqual(await archiveNames(h), ["After", "Other"]);

  // A rename based on an older version is refused with what changed since.
  const stale = await asBot(h, OWNER.userId, "PUT", url, { name: "Again", expectedVersion: 1 });
  const conflict = errorDetails(stale, 409, "stale_version");
  assert.equal(conflict.currentVersion, 2);
  assert.deepEqual(conflict.current, { name: "After" });

  const taken = await asBot(h, OWNER.userId, "PUT", url, { name: "OTHER", expectedVersion: 2 });
  assert.equal(errorDetails(taken, 409, "name_taken").field, "name");
  assert.equal((await getArchive(h, archive.archiveId)).name, "After");
});

test("the owner changes the timezone, lane gap, and colors with the current version", async (t) => {
  const h = await serviceHarness(t);
  const archive = await createArchive(h, "Settings");
  const url = `/api/archives/${archive.archiveId}/settings`;

  const changed = await asBot(h, OWNER.userId, "PATCH", url, {
    expectedVersion: 1,
    timezone: "Europe/London",
    laneGapDays: 30,
    colors: { accent: "#5865F2", lane_default: "#2b2d31" },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const details = changed.json() as ArchiveDetails;
  assert.equal(details.version, 2);
  assert.equal(details.timezone, "Europe/London");
  assert.equal(details.laneGapDays, 30);
  assert.deepEqual(details.colors, { accent: "#5865f2", lane_default: "#2b2d31" });

  const stale = await asBot(h, OWNER.userId, "PATCH", url, { expectedVersion: 1, laneGapDays: 60 });
  const conflict = errorDetails(stale, 409, "stale_version");
  assert.equal(conflict.currentVersion, 2);
  assert.deepEqual(conflict.current, { laneGapDays: 30 });

  const invalid: [fields: object, field: string][] = [
    [{ timezone: "Mars/Olympus_Mons" }, "timezone"],
    [{ laneGapDays: 0 }, "laneGapDays"],
    [{ laneGapDays: 3651 }, "laneGapDays"],
    [{ laneGapDays: 1.5 }, "laneGapDays"],
    [{ colors: ["#ffffff"] }, "colors"],
    [{ colors: { "Not A Role": "#ffffff" } }, "colors"],
    [{ colors: { accent: "blue" } }, "colors.accent"],
  ];
  for (const [fields, field] of invalid) {
    const response = await asBot(h, OWNER.userId, "PATCH", url, { expectedVersion: 2, ...fields });
    assert.equal(errorDetails(response, 400, "invalid_input", JSON.stringify(fields)).field, field);
  }
  const unversioned = await asBot(h, OWNER.userId, "PATCH", url, { laneGapDays: 60 });
  assert.equal(errorDetails(unversioned, 400, "invalid_input").field, "expectedVersion");

  const current = await getArchive(h, archive.archiveId);
  assert.equal(current.version, 2);
  assert.equal(current.laneGapDays, 30);
});

test("the main server must be a server recorded in the same archive", async (t) => {
  const h = await serviceHarness(t);
  const archive = await createArchive(h, "Main");
  const elsewhere = await createArchive(h, "Elsewhere");
  const hangout = await createServer(h, archive.archiveId, "The Hangout");
  const foreign = await createServer(h, elsewhere.archiveId, "Another Place");
  const url = `/api/archives/${archive.archiveId}/settings`;

  for (const mainServerId of [foreign, randomUUID()]) {
    const refused = await asBot(h, OWNER.userId, "PATCH", url, {
      expectedVersion: 1,
      mainServerId,
    });
    assert.equal(errorDetails(refused, 400, "invalid_input").field, "mainServerId");
  }

  const chosen = await asBot(h, OWNER.userId, "PATCH", url, {
    expectedVersion: 1,
    mainServerId: hangout,
  });
  assert.equal(chosen.statusCode, 200, chosen.body);
  assert.equal((chosen.json() as ArchiveDetails).mainServerId, hangout);
  assert.equal((chosen.json() as ArchiveDetails).version, 2);

  const cleared = await asBot(h, OWNER.userId, "PATCH", url, {
    expectedVersion: 2,
    mainServerId: null,
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal((cleared.json() as ArchiveDetails).mainServerId, null);
  assert.equal((cleared.json() as ArchiveDetails).version, 3);
});

test("unregistering keeps the folder, and registering it again restores no old access or settings", async (t) => {
  const h = await serviceHarness(t);
  const archive = await createArchive(h, "Kept");
  await addMember(h, archive.archiveId, MEMBER.userId);
  const url = `/api/archives/${archive.archiveId}`;
  assert.equal((await asBot(h, MEMBER.userId, "GET", url)).statusCode, 200);
  const logsChannel = { guildId: "400000000000000004", channelId: "500000000000000005" };
  const channelSet = await asBot(
    h,
    OWNER.userId,
    "PUT",
    `${url}/artifact-logs-channel`,
    logsChannel,
  );
  assert.equal(channelSet.statusCode, 200, channelSet.body);
  const selected = await asBot(h, OWNER.userId, "POST", "/api/me/archive-selection", {
    archiveId: archive.archiveId,
  });
  assert.equal(selected.statusCode, 200, selected.body);
  const recalled = await asBot(h, OWNER.userId, "POST", "/api/me/archive-selection", {});
  assert.equal((recalled.json() as { archiveId: string }).archiveId, archive.archiveId);

  const removed = await asBot(h, OWNER.userId, "DELETE", url);
  assert.equal(removed.statusCode, 204, removed.body);
  assert.equal(removed.body, "");
  const folder = join(h.context.paths.archivesRoot, archive.archiveId);
  assert.deepEqual(readdirSync(folder).sort(), ["archive.db", "edits.log", "media"]);
  assert.deepEqual(await archiveNames(h), []);
  errorDetails(await asBot(h, OWNER.userId, "GET", url), 404, "archive_not_found");
  errorDetails(await asBot(h, MEMBER.userId, "GET", url), 404, "archive_not_found");
  errorDetails(await asBot(h, OWNER.userId, "DELETE", url), 404, "archive_not_found");

  const registered = await asBot(h, OWNER.userId, "POST", "/api/archives/register", {
    archiveId: archive.archiveId,
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const result = registered.json() as RegisterResult;
  assert.equal(result.archive.archiveId, archive.archiveId);
  assert.equal(result.archive.name, "Kept");
  assert.deepEqual(result.warnings, []);
  assert.equal((await getArchive(h, archive.archiveId)).name, "Kept");

  // Only the owner can open it until members are added again. Its logs channel and
  // the owner's remembered selection went with the old registration.
  assert.deepEqual(await listMembers(h, archive.archiveId), []);
  errorDetails(await asBot(h, MEMBER.userId, "GET", url), 404, "archive_not_found");
  const channel = await asBot(h, OWNER.userId, "GET", `${url}/artifact-logs-channel`);
  assert.equal(channel.statusCode, 200, channel.body);
  assert.deepEqual(channel.json(), { channel: null });
  const remembered = await asBot(h, OWNER.userId, "POST", "/api/me/archive-selection", {});
  assert.equal(errorDetails(remembered, 400, "invalid_input").reason, "archive_required");

  const again = await asBot(h, OWNER.userId, "POST", "/api/archives/register", {
    archiveId: archive.archiveId,
  });
  assert.equal(errorDetails(again, 400, "invalid_input").field, "archiveId");
});

test("registering needs an owner, an archive folder under the archive root, and a free name", async (t) => {
  const h = await serviceHarness(t);
  const archive = await createArchive(h, "Kept");
  const removed = await asBot(h, OWNER.userId, "DELETE", `/api/archives/${archive.archiveId}`);
  assert.equal(removed.statusCode, 204, removed.body);
  await createArchive(h, "KEPT");
  const register = "/api/archives/register";

  const refused = await asBot(h, MEMBER.userId, "POST", register, { archiveId: archive.archiveId });
  errorDetails(refused, 403, "forbidden");
  for (const archiveId of ["../outside", randomUUID(), undefined]) {
    const response = await asBot(h, OWNER.userId, "POST", register, { archiveId });
    assert.equal(
      errorDetails(response, 400, "invalid_input", String(archiveId)).field,
      "archiveId",
    );
  }
  const clash = await asBot(h, OWNER.userId, "POST", register, { archiveId: archive.archiveId });
  assert.equal(errorDetails(clash, 409, "name_taken").field, "name");

  const renamed = await asBot(h, OWNER.userId, "POST", register, {
    archiveId: archive.archiveId,
    name: "Kept Copy",
  });
  assert.equal(renamed.statusCode, 201, renamed.body);
  const result = renamed.json() as RegisterResult;
  assert.equal(result.archive.name, "Kept Copy");
  // The new name is recorded in the archive itself, as a rename by the owner.
  assert.equal(result.archive.version, 2);
  const log = parseLog(
    readFileSync(join(h.context.paths.archivesRoot, archive.archiveId, "edits.log"), "utf8"),
  );
  assert.deepEqual(log.at(-1)?.changes, { name: { old: "Kept", new: "Kept Copy" } });
  assert.equal(log.at(-1)?.editor, OWNER.userId);
  assert.deepEqual(await archiveNames(h), ["KEPT", "Kept Copy"]);
});

test("the owner lists, adds, and removes members, and repeating a change is harmless", async (t) => {
  const h = await serviceHarness(t);
  const archive = await createArchive(h, "Shared");
  const members = `/api/archives/${archive.archiveId}/members`;
  assert.deepEqual(await listMembers(h, archive.archiveId), []);

  const first = await asBot(h, OWNER.userId, "PUT", `${members}/${OTHER.userId}`);
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { added: true });
  const repeated = await asBot(h, OWNER.userId, "PUT", `${members}/${OTHER.userId}`);
  assert.deepEqual(repeated.json(), { added: false });
  h.clock.ms += 60_000;
  await addMember(h, archive.archiveId, MEMBER.userId);

  // The user in the address becomes the member. The acting owner is recorded as granting it.
  assert.deepEqual(await listMembers(h, archive.archiveId), [
    { userId: OTHER.userId, grantedAt: NOW.toISOString(), grantedBy: OWNER.userId },
    {
      userId: MEMBER.userId,
      grantedAt: new Date(NOW.getTime() + 60_000).toISOString(),
      grantedBy: OWNER.userId,
    },
  ]);
  const badId = await asBot(h, OWNER.userId, "PUT", `${members}/not-a-discord-id`);
  assert.equal(errorDetails(badId, 400, "invalid_input").field, "userId");

  const archiveUrl = `/api/archives/${archive.archiveId}`;
  const browser = { [SESSION_COOKIE]: h.cookie(MEMBER) };
  assert.equal((await asBot(h, MEMBER.userId, "GET", archiveUrl)).statusCode, 200);
  assert.equal(
    (await h.inject({ method: "GET", url: archiveUrl, cookies: browser })).statusCode,
    200,
  );

  const removed = await asBot(h, OWNER.userId, "DELETE", `${members}/${MEMBER.userId}`);
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json(), { removed: true });
  const removedAgain = await asBot(h, OWNER.userId, "DELETE", `${members}/${MEMBER.userId}`);
  assert.deepEqual(removedAgain.json(), { removed: false });
  assert.deepEqual(
    (await listMembers(h, archive.archiveId)).map(({ userId }) => userId),
    [OTHER.userId],
  );

  // Removal applies to the member's next request, from the bot or an open browser session.
  errorDetails(await asBot(h, MEMBER.userId, "GET", archiveUrl), 404, "archive_not_found");
  const ended = await h.inject({ method: "GET", url: archiveUrl, cookies: browser });
  assert.equal(errorDetails(ended, 403, "forbidden").reason, "not_admitted");
});

test("a member is refused the owner's routes on their archive and cannot find other archives", async (t) => {
  const h = await serviceHarness(t);
  const shared = await createArchive(h, "Shared");
  const hidden = await createArchive(h, "Hidden");
  await addMember(h, shared.archiveId, MEMBER.userId);

  const archiveRoutes = (archiveId: string): Route[] => [
    ["PUT", `/api/archives/${archiveId}/name`, { name: "Taken Over", expectedVersion: 1 }],
    ["PATCH", `/api/archives/${archiveId}/settings`, { expectedVersion: 1, laneGapDays: 7 }],
    ["DELETE", `/api/archives/${archiveId}`],
    ["GET", `/api/archives/${archiveId}/members`],
    ["PUT", `/api/archives/${archiveId}/members/${OTHER.userId}`],
    ["DELETE", `/api/archives/${archiveId}/members/${MEMBER.userId}`],
    ["POST", `/api/archives/${archiveId}/exports`],
  ];
  for (const [method, url, payload] of archiveRoutes(shared.archiveId)) {
    const response = await asBot(h, MEMBER.userId, method, url, payload);
    errorDetails(response, 403, "forbidden", `${method} ${url}`);
  }
  // An archive the user is not on is reported as missing, so its existence is not revealed.
  const unseen: [userId: string, archiveId: string][] = [
    [MEMBER.userId, hidden.archiveId],
    [OTHER.userId, hidden.archiveId],
    [OTHER.userId, shared.archiveId],
  ];
  for (const [userId, archiveId] of unseen) {
    for (const [method, url, payload] of archiveRoutes(archiveId)) {
      const response = await asBot(h, userId, method, url, payload);
      errorDetails(response, 404, "archive_not_found", `${userId} ${method} ${url}`);
    }
  }
  const ownerOnly: Route[] = [
    ["POST", "/api/archives", { name: "Mine" }],
    ["POST", "/api/archives/register", { archiveId: hidden.archiveId }],
    ["GET", "/api/exports"],
    ["GET", `/api/exports/${randomUUID()}`],
  ];
  for (const [method, url, payload] of ownerOnly) {
    const response = await asBot(h, MEMBER.userId, method, url, payload);
    errorDetails(response, 403, "forbidden", `${method} ${url}`);
  }

  // Nothing the refused requests asked for happened.
  const current = await getArchive(h, shared.archiveId);
  assert.equal(current.name, "Shared");
  assert.equal(current.version, 1);
  assert.equal(current.laneGapDays, 90);
  assert.deepEqual(await archiveNames(h), ["Hidden", "Shared"]);
  assert.deepEqual(
    (await listMembers(h, shared.archiveId)).map(({ userId }) => userId),
    [MEMBER.userId],
  );
  assert.deepEqual(await listMembers(h, hidden.archiveId), []);
  assert.deepEqual(await listExports(h), []);
});

test("the owner exports an archive to a zip on the service host and follows the job", async (t) => {
  const h = await serviceHarness(t);
  const archive = await createArchive(h, "Old Days");
  await createServer(h, archive.archiveId, "The Hangout");
  await addMember(h, archive.archiveId, MEMBER.userId);
  const exportsUrl = `/api/archives/${archive.archiveId}/exports`;

  const started = await asBot(h, OWNER.userId, "POST", exportsUrl);
  assert.equal(started.statusCode, 202, started.body);
  // The reply describes the job. The archive's bytes never leave the host.
  assert.match(String(started.headers["content-type"]), /^application\/json/);
  const job = started.json() as ExportJob;
  assert.ok(job.state === "running" || job.state === "ready", job.state);
  assert.equal(job.archiveId, archive.archiveId);
  assert.equal(job.archiveName, "Old Days");
  assert.equal(job.requestedBy, OWNER.userId);
  assert.equal(job.createdMs, NOW.getTime());
  assert.equal(job.errorCode, null);

  const ready = await waitForExport(h, job.id);
  assert.equal(ready.id, job.id);
  assert.equal(ready.path, job.path);
  assert.ok(ready.path);
  assert.equal(dirname(ready.path), h.context.paths.exportsDir);
  assert.match(basename(ready.path), /^Old-Days-2026-11-23-[0-9a-f]{8}\.zip$/);
  assert.ok(existsSync(ready.path));
  assert.equal(ready.onDisk, true);
  assert.equal(ready.byteLength, statSync(ready.path).size);
  // The zip is renamed into place once complete, so no partial file is left beside it.
  assert.deepEqual(readdirSync(h.context.paths.exportsDir), [basename(ready.path)]);

  const entries = zipEntries(ready.path);
  assert.ok(entries.includes(`${archive.archiveId}/archive.db`), entries.join(", "));
  assert.ok(entries.includes(`${archive.archiveId}/edits.log`), entries.join(", "));
  // Only the archive's own folder is zipped, never the service's operational state.
  assert.ok(
    entries.every((entry) => entry.startsWith(`${archive.archiveId}/`)),
    entries.join(", "),
  );
  assert.deepEqual(await listExports(h), [ready]);

  // Exports are the owner's alone, even for a member of the archive.
  errorDetails(await asBot(h, MEMBER.userId, "POST", exportsUrl), 403, "forbidden");
  errorDetails(await asBot(h, MEMBER.userId, "GET", "/api/exports"), 403, "forbidden");
  errorDetails(await asBot(h, MEMBER.userId, "GET", `/api/exports/${job.id}`), 403, "forbidden");
  assert.deepEqual(await listExports(h), [ready]);
  assert.deepEqual(h.logged, []);
});

test("the export list shows the newest first and takes a limit from 1 to 50", async (t) => {
  const h = await serviceHarness(t);
  const archive = await createArchive(h, "Twice");
  const first = await exportArchive(h, archive.archiveId);
  h.clock.ms += 60_000;
  const second = await exportArchive(h, archive.archiveId);
  assert.notEqual(first.path, second.path);

  assert.deepEqual(
    (await listExports(h)).map(({ id }) => id),
    [second.id, first.id],
  );
  assert.deepEqual(
    (await listExports(h, "?limit=1")).map(({ id }) => id),
    [second.id],
  );
  assert.equal((await listExports(h, "?limit=50")).length, 2);
  for (const limit of ["0", "51", "1.5", "many"]) {
    const response = await asBot(h, OWNER.userId, "GET", `/api/exports?limit=${limit}`);
    assert.equal(errorDetails(response, 400, "invalid_input", limit).field, "limit");
  }
  const unknown = await asBot(h, OWNER.userId, "GET", `/api/exports/${randomUUID()}`);
  errorDetails(unknown, 404, "not_found");
});
