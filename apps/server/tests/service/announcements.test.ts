import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import {
  setAnnouncementChannel,
  removeAnnouncementChannel,
  settleExpiredClaims,
} from "../../src/archivist/announcements.js";
import { createArchive } from "../../src/archivist/archives.js";
import { type ArtifactDetails, createArtifact } from "../../src/archivist/artifacts.js";
import { closeStore, journalFile, openStore } from "../../src/archivist/context.js";
import { createCharacter } from "../../src/archivist/entities.js";
import { ArchivistError } from "../../src/archivist/errors.js";
import { addMember } from "../../src/archivist/members.js";
import { createStagingFolder, stageMedia } from "../../src/archivist/media.js";
import { closeMetadataReader } from "../../src/archivist/metadata.js";
import { closeFixtureWriter, writeImage } from "../archivist/helpers/media.js";
import { makeTempDir } from "../archivist/helpers/temp-dir.js";
import { MEMBER, multipart, OWNER, serviceHarness, type ServiceHarness } from "./harness.js";

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

const GUILD_ID = "727573539904815224";
const CHANNEL_ID = "900000000000000111";
const MESSAGE_ID = "1311000000000000001";
const CLAIM_LEASE = 10 * 60_000;
const CRASH_KEY = "5c0f6a8e-2b1d-4c3e-9f70-1a2b3c4d5e6f";

interface Item {
  archiveId: string;
  artifactId: string;
  claimId: string;
  channel: { guildId: string; channelId: string };
  archiveName: string;
  archiveTimeZone: string;
  artifact: ArtifactDetails;
  characterNames: string[];
  previewPath: string | null;
}

async function setup(t: TestContext) {
  const h = await serviceHarness(t);
  const { archiveId } = createArchive(h.context, OWNER, { name: "Hangout" });
  addMember(h.context, OWNER, { archiveId, userId: MEMBER.userId });
  setAnnouncementChannel(h.context, MEMBER, {
    archiveId,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
  });
  const sam = createCharacter(h.context, MEMBER, { archiveId, knownName: "Sam" });
  const imageFile = join(makeTempDir(t), "photo.png");
  await writeImage(imageFile, "png");
  const image = readFileSync(imageFile);
  const cookie = h.cookie(MEMBER);

  /** Adds an artifact from the website, as a member would. */
  const upload = async (description: string) => {
    const body = await multipart(
      { description, characters: [sam.id] },
      { name: `${description}.png`, bytes: image },
    );
    const response = await h.inject({
      method: "POST",
      url: `/api/archives/${archiveId}/artifacts/intake`,
      headers: { origin: h.origin, "content-type": body.contentType },
      cookies: { archivist_session: cookie },
      payload: body.payload,
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as { artifact: ArtifactDetails; announcement: { status: string } };
  };
  const browser = (method: "PATCH" | "DELETE", path: string, payload?: object) =>
    h.inject({
      method,
      url: `/api/archives/${archiveId}${path}`,
      headers: { origin: h.origin },
      cookies: { archivist_session: cookie },
      ...(payload ? { payload } : {}),
    });
  const claim = (payload: object = {}) =>
    h.inject({
      method: "POST",
      url: "/api/service/announcements/claim",
      headers: h.botOnly(),
      payload,
    });
  const claimed = async (payload: object = {}) => {
    const response = await claim(payload);
    assert.equal(response.statusCode, 200, response.body);
    return (response.json() as { items: Item[] }).items;
  };
  const report = (artifactId: string, payload: object) =>
    h.inject({
      method: "POST",
      url: `/api/service/announcements/${archiveId}/${artifactId}/result`,
      headers: h.botOnly(),
      payload,
    });
  return { h, archiveId, sam, image, upload, browser, claim, claimed, report };
}

function delivery(h: ServiceHarness, artifactId: string) {
  return h.context.botDb
    .prepare(
      "SELECT state, message_id AS messageId, error_code AS errorCode, claim_id AS claimId FROM archivist_announcements WHERE artifact_id = ?",
    )
    .get(artifactId) as
    | { state: string; messageId: string | null; errorCode: string | null; claimId: string }
    | undefined;
}

test("a new artifact's post is queued with the artifact as submitted, handed out once, and its result recorded", async (t) => {
  const { h, archiveId, upload, browser, claimed, report } = await setup(t);
  const made = await upload("Meetup photo");
  assert.deepEqual(made.announcement, { status: "queued" });
  const artifact = made.artifact;

  // A later edit does not change the post, which shows the upload as it was.
  const edited = await browser("PATCH", `/artifacts/${artifact.id}`, {
    expectedVersion: 1,
    description: "Edited later",
  });
  assert.equal(edited.statusCode, 200, edited.body);

  const [item, ...rest] = await claimed();
  assert.deepEqual(rest, []);
  assert.ok(item);
  assert.equal(item.archiveId, archiveId);
  assert.equal(item.artifactId, artifact.id);
  assert.deepEqual(item.channel, { guildId: GUILD_ID, channelId: CHANNEL_ID });
  assert.equal(item.archiveName, "Hangout");
  assert.equal(item.archiveTimeZone, "America/Toronto");
  assert.equal(item.artifact.description, "Meetup photo");
  assert.deepEqual(item.characterNames, ["Sam"]);
  assert.match(item.claimId, /^[0-9a-f-]{36}$/);
  assert.equal(item.previewPath, `/api/service/announcements/${archiveId}/${artifact.id}/preview`);
  assert.equal(delivery(h, artifact.id)?.state, "pending");
  assert.deepEqual(await claimed(), [], "a claimed post is not handed out again");

  const preview = await h.inject({ method: "GET", url: item.previewPath!, headers: h.botOnly() });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.headers["content-type"], "image/webp");
  assert.equal(preview.rawPayload.subarray(8, 12).toString("ascii"), "WEBP");

  // Sent needs the message, and is then recorded. Saying so again is harmless.
  const missing = await report(artifact.id, { claimId: item.claimId, state: "sent" });
  assert.equal(missing.statusCode, 400);
  const sent = { claimId: item.claimId, state: "sent", messageId: MESSAGE_ID };
  assert.equal((await report(artifact.id, sent)).statusCode, 204);
  assert.equal((await report(artifact.id, sent)).statusCode, 204);
  assert.deepEqual(delivery(h, artifact.id), {
    state: "sent",
    messageId: MESSAGE_ID,
    errorCode: null,
    claimId: item.claimId,
  });

  // A different story about a settled post, or a claim that was never issued, is refused.
  const changed = await report(artifact.id, { claimId: item.claimId, state: "failed" });
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().details.reason, "stale_claim");
  const forged = await report(artifact.id, {
    claimId: "00000000-0000-4000-8000-000000000000",
    state: "sent",
    messageId: MESSAGE_ID,
  });
  assert.equal(forged.statusCode, 409);
  assert.equal(forged.json().details.reason, "stale_claim");
  assert.equal(delivery(h, artifact.id)?.state, "sent");

  const never = await upload("Never claimed");
  const unknown = await report(never.artifact.id, {
    claimId: "00000000-0000-4000-8000-000000000000",
    state: "sent",
    messageId: MESSAGE_ID,
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().details.reason, "unknown_claim");
});

test("an archive without a logs channel queues nothing", async (t) => {
  const { h, archiveId, upload, claimed } = await setup(t);
  removeAnnouncementChannel(h.context, MEMBER, { archiveId });
  const made = await upload("Quiet");
  assert.deepEqual(made.announcement, { status: "not_configured" });
  assert.deepEqual(await claimed(), []);
  assert.equal(delivery(h, made.artifact.id), undefined);
});

test("an artifact deleted before the bot claims its post is never announced", async (t) => {
  const { h, upload, browser, claimed } = await setup(t);
  const made = await upload("Short lived");
  const deleted = await browser("DELETE", `/artifacts/${made.artifact.id}?expectedVersion=1`);
  assert.equal(deleted.statusCode, 204, deleted.body);
  assert.deepEqual(await claimed(), []);
  assert.equal(delivery(h, made.artifact.id)?.state, "failed");
  assert.equal(delivery(h, made.artifact.id)?.errorCode, "artifact_deleted");
});

test("claims can be narrowed to one artifact, and their limit is checked", async (t) => {
  const { archiveId, upload, claim, claimed } = await setup(t);
  const first = await upload("First");
  const second = await upload("Second");
  const narrowed = await claimed({ archiveId, artifactId: second.artifact.id });
  assert.deepEqual(
    narrowed.map((item) => item.artifactId),
    [second.artifact.id],
  );
  for (const payload of [{ limit: 0 }, { limit: 26 }, { limit: "5" }, { artifactId: "abc" }]) {
    const refused = await claim(payload);
    assert.equal(refused.statusCode, 400, JSON.stringify(payload));
  }
  assert.deepEqual(
    (await claimed({ limit: 1 })).map((item) => item.artifactId),
    [first.artifact.id],
  );
});

test("a claim the bot does not report on becomes indeterminate, and a later report still records", async (t) => {
  const { h, upload, claimed, report } = await setup(t);
  const made = await upload("Slow post");
  const [item] = await claimed();
  assert.ok(item);

  h.clock.ms += CLAIM_LEASE - 1_000;
  assert.equal(settleExpiredClaims(h.context), 0);
  h.clock.ms += 2_000;
  assert.equal(settleExpiredClaims(h.context), 1);
  assert.equal(delivery(h, made.artifact.id)?.state, "indeterminate");
  assert.equal(delivery(h, made.artifact.id)?.errorCode, "claim_expired");
  assert.deepEqual(await claimed(), [], "an indeterminate post is never handed out again");

  const late = await report(made.artifact.id, {
    claimId: item.claimId,
    state: "sent",
    messageId: MESSAGE_ID,
  });
  assert.equal(late.statusCode, 204);
  assert.equal(delivery(h, made.artifact.id)?.state, "sent");
});

test("only the bot can use the announcement routes", async (t) => {
  const { h, archiveId, upload, claimed } = await setup(t);
  const made = await upload("Private");
  const owner = h.cookie(OWNER);
  const asBrowser = await h.inject({
    method: "POST",
    url: "/api/service/announcements/claim",
    headers: { origin: h.origin },
    cookies: { archivist_session: owner },
    payload: {},
  });
  assert.equal(asBrowser.statusCode, 403);
  assert.equal(asBrowser.json().details.reason, "service_only");
  const anonymous = await h.inject({ method: "POST", url: "/api/service/announcements/claim" });
  assert.equal(anonymous.statusCode, 403);
  const wrongToken = await h.inject({
    method: "POST",
    url: "/api/service/announcements/claim",
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(wrongToken.statusCode, 401);
  assert.equal(wrongToken.json().details.reason, "invalid_service_token");

  // The preview is only for a post the bot has claimed.
  const previewPath = `/api/service/announcements/${archiveId}/${made.artifact.id}/preview`;
  assert.equal(
    (await h.inject({ method: "GET", url: previewPath, headers: h.botOnly() })).statusCode,
    404,
  );
  await claimed();
  const browserPreview = await h.inject({
    method: "GET",
    url: previewPath,
    cookies: { archivist_session: owner },
  });
  assert.equal(browserPreview.statusCode, 403);
  assert.equal(
    (await h.inject({ method: "GET", url: previewPath, headers: h.botOnly() })).statusCode,
    200,
  );
});

test("a crash between saving an artifact and queueing its post is finished when the archive reopens", async (t) => {
  const { h, archiveId, sam, image } = await setup(t);
  const queued = () =>
    (
      h.context.botDb.prepare("SELECT count(*) AS n FROM archivist_announcement_queue").get() as {
        n: number;
      }
    ).n;

  // The follow-up fails after the database commit, as if the service stopped right then.
  const store = openStore(h.context, archiveId);
  store.hooks = {
    applyFollowUp() {
      throw new Error("stopped");
    },
  };
  const file = join(createStagingFolder(h.context), "original");
  writeFileSync(file, image);
  const media = await stageMedia(h.context, { file, originalFilename: "crash.png" });
  assert.throws(
    () =>
      createArtifact(h.context, MEMBER, {
        archiveId,
        description: "Saved before the crash",
        source: { provider: "web_upload", key: CRASH_KEY },
        links: { characters: [sam.id] },
        media,
      }),
    (error) => error instanceof ArchivistError && error.code === "dependency_unavailable",
  );
  const saved = store.db.prepare("SELECT id FROM artifacts WHERE source_key = ?").get(CRASH_KEY) as
    { id: string } | undefined;
  assert.ok(saved, "the artifact itself was saved");
  assert.equal(queued(), 0);
  assert.ok(
    existsSync(journalFile(h.context, archiveId)),
    "the journal records the unfinished step",
  );

  // Reopening the archive finishes the follow-up with the real hooks, once.
  closeStore(h.context, archiveId);
  openStore(h.context, archiveId);
  assert.equal(queued(), 1);
  assert.ok(!existsSync(journalFile(h.context, archiveId)));
  closeStore(h.context, archiveId);
  openStore(h.context, archiveId);
  assert.equal(queued(), 1);

  const claim = await h.inject({
    method: "POST",
    url: "/api/service/announcements/claim",
    headers: h.botOnly(),
    payload: {},
  });
  const items = (claim.json() as { items: Item[] }).items;
  assert.deepEqual(
    items.map((item) => [item.artifactId, item.artifact.description, item.characterNames]),
    [[saved.id, "Saved before the crash", ["Sam"]]],
  );
});
