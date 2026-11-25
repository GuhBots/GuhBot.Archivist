import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { setAnnouncementChannel } from "../../src/archivist/announcements.js";
import { createArchive } from "../../src/archivist/archives.js";
import type { ArtifactDetails } from "../../src/archivist/artifacts.js";
import { createCharacter } from "../../src/archivist/entities.js";
import { addMember } from "../../src/archivist/members.js";
import { closeMetadataReader } from "../../src/archivist/metadata.js";
import { archiveFolder } from "../../src/archivist/paths.js";
import { REVIEW_LIFETIME_MS } from "../../src/archivist/web/reviews.js";
import { closeFixtureWriter, writeImage } from "../archivist/helpers/media.js";
import { makeTempDir } from "../archivist/helpers/temp-dir.js";
import { type HarnessOptions, MEMBER, multipart, OTHER, OWNER, serviceHarness } from "./harness.js";

/**
 * Adding artifacts through the whole service, as the Discord bot does with
 * its credential and as a browser does with its session, and the date
 * preview the bot shows before it sends a time typed without a zone.
 */

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

const GUILD_ID = "727573539904815224";
const CHANNEL_ID = "900000000000000111";
const MESSAGE_ID = "1311000000000000001";
const ATTACHMENT_ID = "1311000000000000002";
/** Where Discord serves the attachment. */
const ATTACHMENT_ADDRESS = `https://cdn.discordapp.com/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/meetup.png`;
/** The address as the bot receives it, with a signature that expires. */
const SIGNED_ADDRESS = `${ATTACHMENT_ADDRESS}?ex=6744f1a2&is=6743a022&hm=9b1c3e5f7a0d&`;
const DRIVE_FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-012";
const DRIVE_LINK = `https://drive.google.com/file/d/${DRIVE_FILE_ID}/view`;

type Fields = Record<string, string | string[]>;
type FileUpload = { name: string; bytes: Buffer };

async function imageBytes(t: TestContext, format: "png" | "jpeg" = "png"): Promise<Buffer> {
  const file = join(makeTempDir(t), `photo.${format}`);
  await writeImage(file, format);
  return readFileSync(file);
}

/** Google's public download address, serving one PNG and counting full downloads. */
function fakeDrive(bytes: Buffer): { fetch: typeof fetch; downloads: () => number } {
  let downloads = 0;
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "drive.usercontent.google.com");
    if (new Headers(init.headers).get("range") === "bytes=0-0") {
      return new Response(bytes.subarray(0, 1), {
        status: 206,
        headers: {
          "content-type": "image/png",
          "content-range": `bytes 0-0/${bytes.length}`,
          "content-disposition": `attachment; filename="trip.png"`,
        },
      });
    }
    downloads += 1;
    return new Response(bytes, {
      headers: { "content-type": "image/png", "content-length": String(bytes.length) },
    });
  }) as typeof fetch;
  return { fetch: fakeFetch, downloads: () => downloads };
}

async function setup(t: TestContext, options: HarnessOptions = {}) {
  const h = await serviceHarness(t, options);
  const { archiveId } = createArchive(h.context, OWNER, { name: "Hangout" });
  addMember(h.context, OWNER, { archiveId, userId: MEMBER.userId });
  // A logs channel, so new artifacts are queued for the bot to announce.
  setAnnouncementChannel(h.context, MEMBER, {
    archiveId,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
  });
  const sam = createCharacter(h.context, MEMBER, { archiveId, knownName: "Sam" });

  /** Sends an intake form from the bot, acting for MEMBER unless told otherwise. */
  const botUpload = async (
    fields: Fields,
    file?: FileUpload,
    { as = MEMBER.userId, archive = archiveId }: { as?: string; archive?: string } = {},
  ) => {
    const form = await multipart(fields, file);
    return h.inject({
      method: "POST",
      url: `/api/archives/${archive}/artifacts/intake`,
      headers: h.bot(as, { "content-type": form.contentType }),
      payload: form.payload,
    });
  };
  /** Reads a path under the archive as the bot, acting for MEMBER unless told otherwise. */
  const botGet = (path: string, as = MEMBER.userId) =>
    h.inject({ method: "GET", url: `/api/archives/${archiveId}${path}`, headers: h.bot(as) });
  /** Intake folders left in staging. The folder does not exist before the first upload. */
  const staged = () => {
    const folder = join(h.context.paths.tmpDir, "staging");
    return existsSync(folder) ? readdirSync(folder) : [];
  };
  /** Original files kept in an archive's folder. */
  const originals = (archive = archiveId) =>
    readdirSync(join(archiveFolder(h.context.paths, archive), "media", "originals"));
  /** Artifacts waiting for the bot to announce them. */
  const announced = () =>
    (
      h.context.botDb
        .prepare(
          "SELECT artifact_id AS id FROM archivist_announcement_queue ORDER BY queued_at, artifact_id",
        )
        .all() as { id: string }[]
    ).map((row) => row.id);
  const artifactCount = async () => (await botGet("/artifacts")).json().total as number;
  return { h, archiveId, sam, botUpload, botGet, staged, originals, announced, artifactCount };
}

test("a Discord attachment from the bot keeps its source, submission, and creator, and its original streams back unchanged", async (t) => {
  const { botUpload, botGet, staged, announced } = await setup(t);
  const bytes = await imageBytes(t);

  const made = await botUpload(
    {
      description: "Meetup photo",
      discordAttachmentId: ATTACHMENT_ID,
      discordAttachmentUrl: SIGNED_ADDRESS,
      submissionGuildId: GUILD_ID,
      submissionChannelId: CHANNEL_ID,
      submissionMessageId: MESSAGE_ID,
    },
    { name: "meetup.png", bytes },
  );
  assert.equal(made.statusCode, 201, made.body);
  // The bot's credential never starts a browser session.
  assert.equal(made.headers["set-cookie"], undefined);
  assert.equal(made.json().status, "created");
  assert.deepEqual(made.json().announcement, { status: "queued" });
  const artifact = made.json().artifact as ArtifactDetails;
  assert.deepEqual(artifact.source, {
    provider: "discord_attachment",
    key: ATTACHMENT_ID,
    url: ATTACHMENT_ADDRESS,
    resourceKey: null,
  });
  assert.deepEqual(artifact.submission, {
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    messageId: MESSAGE_ID,
  });
  assert.equal(artifact.createdBy, MEMBER.userId);
  assert.equal(artifact.media.originalFilename, "meetup.png");
  assert.equal(artifact.media.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(announced(), [artifact.id]);
  assert.deepEqual(staged(), []);

  const original = await botGet(`/media/${artifact.media.id}`);
  assert.equal(original.statusCode, 200);
  assert.equal(original.headers["content-type"], "image/png");
  assert.deepEqual(original.rawPayload, bytes);
  // The credential opens only what the contributor it acts for may see.
  assert.equal((await botGet(`/media/${artifact.media.id}`, OTHER.userId)).statusCode, 404);
});

test("resubmitting an archived attachment opens a review for the same contributor and archive without keeping the file", async (t) => {
  const { h, archiveId, sam, botUpload, botGet, staged, originals, announced } = await setup(t);
  const bytes = await imageBytes(t);
  const fields = {
    description: "Meetup photo",
    discordAttachmentId: ATTACHMENT_ID,
    discordAttachmentUrl: SIGNED_ADDRESS,
  };
  const made = await botUpload(fields, { name: "meetup.png", bytes });
  assert.equal(made.statusCode, 201, made.body);
  const original = made.json().artifact as ArtifactDetails;

  // The attachment ID is the identity, so other bytes under the same ID are the same source.
  const again = await botUpload(
    { ...fields, description: "Meetup photo, cropped", characters: [sam.id] },
    { name: "cropped.jpg", bytes: await imageBytes(t, "jpeg") },
  );
  assert.equal(again.statusCode, 200, again.body);
  const review = again.json();
  assert.equal(review.status, "duplicate");
  assert.equal(review.artifact.id, original.id);
  assert.deepEqual(review.differences, [
    { key: "description", current: "Meetup photo", proposed: "Meetup photo, cropped" },
    { key: "characters", current: "", proposed: sam.id },
  ]);
  assert.equal(typeof review.reviewToken, "string");
  assert.deepEqual(staged(), []);
  assert.equal(originals().length, 1);
  assert.deepEqual(announced(), [original.id], "a duplicate is not announced");

  const elsewhere = createArchive(h.context, OWNER, { name: "Elsewhere" }).archiveId;
  addMember(h.context, OWNER, { archiveId: elsewhere, userId: MEMBER.userId });
  const apply = (as: string, archive = archiveId) =>
    h.inject({
      method: "POST",
      url: `/api/archives/${archive}/artifacts/reviews/${review.reviewToken}/apply`,
      headers: h.bot(as),
      payload: { selected: ["characters"] },
    });
  // Another contributor, even an owner, cannot use the review, and neither can another archive.
  // Neither attempt uses it up.
  const byOwner = await apply(OWNER.userId);
  assert.equal(byOwner.statusCode, 404);
  assert.equal(byOwner.json().details.reason, "review_expired");
  const fromElsewhere = await apply(MEMBER.userId, elsewhere);
  assert.equal(fromElsewhere.statusCode, 404);
  assert.equal(fromElsewhere.json().details.reason, "review_expired");

  const applied = await apply(MEMBER.userId);
  assert.equal(applied.statusCode, 200, applied.body);
  const updated = applied.json() as ArtifactDetails;
  // Only the ticked difference changed. The link was added and the original file kept.
  assert.deepEqual(updated.links.characters, [sam.id]);
  assert.equal(updated.description, "Meetup photo");
  assert.equal(updated.version, original.version + 1);
  assert.deepEqual(updated.source, original.source);
  assert.deepEqual(updated.media, original.media);
  assert.deepEqual((await botGet(`/media/${original.media.id}`)).rawPayload, bytes);
  assert.equal(originals().length, 1);
  assert.deepEqual(announced(), [original.id]);
  assert.equal((await apply(MEMBER.userId)).statusCode, 404, "a review works once");

  // Resubmitting what is now saved has nothing to review.
  const same = await botUpload({ ...fields, characters: [sam.id] }, { name: "meetup.png", bytes });
  assert.equal(same.statusCode, 200, same.body);
  assert.equal(same.json().status, "duplicate");
  assert.deepEqual(same.json().differences, []);
  assert.equal(same.json().reviewToken, null);
});

test("an attachment counts as a duplicate only in its own archive and only while its artifact exists", async (t) => {
  const { h, archiveId, botUpload } = await setup(t);
  const file = { name: "meetup.png", bytes: await imageBytes(t) };
  const fields = { description: "Meetup photo", discordAttachmentId: ATTACHMENT_ID };
  const made = await botUpload(fields, file);
  assert.equal(made.statusCode, 201, made.body);
  const original = made.json().artifact as ArtifactDetails;

  const elsewhere = createArchive(h.context, OWNER, { name: "Elsewhere" }).archiveId;
  addMember(h.context, OWNER, { archiveId: elsewhere, userId: MEMBER.userId });
  const copied = await botUpload(fields, file, { archive: elsewhere });
  assert.equal(copied.statusCode, 201, copied.body);
  assert.notEqual(copied.json().artifact.id, original.id);
  // That archive has no logs channel, so nothing waits to be announced there.
  assert.deepEqual(copied.json().announcement, { status: "not_configured" });

  const deleted = await h.inject({
    method: "DELETE",
    url: `/api/archives/${archiveId}/artifacts/${original.id}?expectedVersion=1`,
    headers: h.bot(MEMBER.userId),
  });
  assert.equal(deleted.statusCode, 204, deleted.body);
  const again = await botUpload(fields, file);
  assert.equal(again.statusCode, 201, again.body);
  assert.notEqual(again.json().artifact.id, original.id);
});

test("a duplicate review expires after 15 minutes and applies only to the version it showed", async (t) => {
  const { h, archiveId, sam, botUpload, botGet } = await setup(t);
  const file = { name: "meetup.png", bytes: await imageBytes(t) };
  const fields = { description: "Meetup photo", discordAttachmentId: ATTACHMENT_ID };
  const made = await botUpload(fields, file);
  assert.equal(made.statusCode, 201, made.body);
  const original = made.json().artifact as ArtifactDetails;
  const startReview = async () => {
    const reply = await botUpload({ ...fields, characters: [sam.id] }, file);
    assert.equal(reply.json().status, "duplicate", reply.body);
    return reply.json().reviewToken as string;
  };
  const apply = (token: string) =>
    h.inject({
      method: "POST",
      url: `/api/archives/${archiveId}/artifacts/reviews/${token}/apply`,
      headers: h.bot(MEMBER.userId),
      payload: { selected: ["characters"] },
    });

  const expiring = await startReview();
  h.clock.ms += REVIEW_LIFETIME_MS;
  const late = await apply(expiring);
  assert.equal(late.statusCode, 404);
  assert.equal(late.json().details.reason, "review_expired");

  // An edit after the review was shown makes it stale, so nothing is applied.
  const stale = await startReview();
  const edited = await h.inject({
    method: "PATCH",
    url: `/api/archives/${archiveId}/artifacts/${original.id}`,
    headers: h.bot(MEMBER.userId),
    payload: { expectedVersion: 1, description: "Meetup photo at the park" },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  const refused = await apply(stale);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, "stale_version");
  assert.deepEqual((await botGet(`/artifacts/${original.id}`)).json().links.characters, []);
});

test("a browser cannot send the bot's Discord fields, and nothing is kept when it tries", async (t) => {
  const { h, archiveId, staged, artifactCount } = await setup(t);
  const file = { name: "meetup.png", bytes: await imageBytes(t) };
  const cookie = h.cookie(MEMBER);
  const browserUpload = async (fields: Fields) => {
    const form = await multipart(fields, file);
    return h.inject({
      method: "POST",
      url: `/api/archives/${archiveId}/artifacts/intake`,
      headers: { origin: h.origin, "content-type": form.contentType },
      cookies: { archivist_session: cookie },
      payload: form.payload,
    });
  };
  const botFields = {
    discordAttachmentId: ATTACHMENT_ID,
    discordAttachmentUrl: SIGNED_ADDRESS,
    submissionGuildId: GUILD_ID,
    submissionChannelId: CHANNEL_ID,
    submissionMessageId: MESSAGE_ID,
  };
  for (const [name, value] of Object.entries(botFields)) {
    const refused = await browserUpload({ description: "Meetup photo", [name]: value });
    assert.equal(refused.statusCode, 403, name);
    assert.equal(refused.json().code, "forbidden", name);
    assert.equal(refused.json().details.field, name);
  }
  // A Drive link sent as JSON is refused the same way, before anything is downloaded.
  const linked = await h.inject({
    method: "POST",
    url: `/api/archives/${archiveId}/artifacts/intake`,
    headers: { origin: h.origin },
    cookies: { archivist_session: cookie },
    payload: { description: "Road trip", driveLink: DRIVE_LINK, submissionMessageId: MESSAGE_ID },
  });
  assert.equal(linked.statusCode, 403);
  assert.equal(linked.json().details.field, "submissionMessageId");
  assert.equal(await artifactCount(), 0);
  assert.deepEqual(staged(), []);
  assert.deepEqual(h.logged, []);

  // Without those fields, the same upload is an ordinary web upload.
  const plain = await browserUpload({ description: "Meetup photo" });
  assert.equal(plain.statusCode, 201, plain.body);
  assert.equal(plain.json().artifact.source.provider, "web_upload");
});

test("the bot's upload is refused before anything is kept when a field comes late, the file is missing, or the attachment is not Discord's", async (t) => {
  const { h, archiveId, sam, botUpload, staged, artifactCount } = await setup(t);
  const bytes = await imageBytes(t);
  const file = { name: "meetup.png", bytes };
  const fields = { description: "Meetup photo", discordAttachmentId: ATTACHMENT_ID };

  // The harness always puts the file last, so this form is built by hand.
  const form = new FormData();
  form.append("description", "Meetup photo");
  form.append("discordAttachmentId", ATTACHMENT_ID);
  form.append("file", new Blob([bytes]), "meetup.png");
  form.append("characters", sam.id);
  const encoded = new Request("http://localhost/", { method: "POST", body: form });
  const late = await h.inject({
    method: "POST",
    url: `/api/archives/${archiveId}/artifacts/intake`,
    headers: h.bot(MEMBER.userId, { "content-type": encoded.headers.get("content-type")! }),
    payload: Buffer.from(await encoded.arrayBuffer()),
  });
  assert.equal(late.statusCode, 400, late.body);
  assert.equal(late.json().details.field, "characters");

  // Exactly one of a file or a Drive link.
  const neither = await botUpload({ description: "Meetup photo" });
  assert.equal(neither.statusCode, 400, neither.body);
  assert.equal(neither.json().details.field, "file");
  const both = await botUpload({ description: "Meetup photo", driveLink: DRIVE_LINK }, file);
  assert.equal(both.statusCode, 400, both.body);
  assert.equal(both.json().details.field, "file");

  // A Discord attachment comes with its file, so a Drive link cannot stand in for it.
  const withLink = { ...fields, driveLink: DRIVE_LINK };
  const linkInForm = await botUpload(withLink);
  assert.equal(linkInForm.statusCode, 400, linkInForm.body);
  assert.equal(linkInForm.json().details.field, "file");
  const linkInJson = await h.inject({
    method: "POST",
    url: `/api/archives/${archiveId}/artifacts/intake`,
    headers: h.bot(MEMBER.userId),
    payload: withLink,
  });
  assert.equal(linkInJson.statusCode, 400, linkInJson.body);
  assert.equal(linkInJson.json().details.field, "file");

  // Only Discord's own file hosts, over HTTPS, can be the attachment's address.
  for (const address of [
    "https://example.com/attachments/1/2/meetup.png",
    "http://cdn.discordapp.com/attachments/1/2/meetup.png",
    "https://cdn.discordapp.com.example.com/attachments/1/2/meetup.png",
    "https://cdn.discordapp.com@example.com/attachments/1/2/meetup.png",
    "cdn.discordapp.com/attachments/1/2/meetup.png",
  ]) {
    const refused = await botUpload({ ...fields, discordAttachmentUrl: address }, file);
    assert.equal(refused.statusCode, 400, address);
    assert.equal(refused.json().details.field, "discordAttachmentUrl", address);
  }
  for (const id of ["1234567890123456", "123456789012345678901", "13110000000000000x2", "none"]) {
    const refused = await botUpload({ ...fields, discordAttachmentId: id }, file);
    assert.equal(refused.statusCode, 400, id);
    assert.equal(refused.json().details.field, "discordAttachmentId", id);
  }

  // Access is checked before the upload is read.
  const outsider = await botUpload(fields, file, { as: OTHER.userId });
  assert.equal(outsider.statusCode, 404, outsider.body);
  assert.equal(outsider.json().code, "archive_not_found");

  assert.equal(await artifactCount(), 0);
  assert.deepEqual(staged(), []);
  assert.deepEqual(h.logged, []);

  // Discord's media host is accepted too, and its query is dropped the same way.
  const resizedAddress = `https://media.discordapp.net/attachments/${CHANNEL_ID}/${ATTACHMENT_ID}/meetup.png`;
  const resized = await botUpload(
    { ...fields, discordAttachmentUrl: `${resizedAddress}?width=400&height=300` },
    file,
  );
  assert.equal(resized.statusCode, 201, resized.body);
  assert.equal(resized.json().artifact.source.url, resizedAddress);
});

test("a time the bot sends without a zone is read in the contributor's timezone without a confirmation", async (t) => {
  const { botUpload } = await setup(t);
  const file = { name: "late.png", bytes: await imageBytes(t) };
  const fields = {
    description: "Late night",
    exactDate: "2019-07-15 6:30pm",
    discordAttachmentId: ATTACHMENT_ID,
  };

  // The owner dropped the confirmation on 2026-11-25. The bot may still send it, and it changes nothing.
  const saved = await botUpload(fields, file);
  assert.equal(saved.statusCode, 201, saved.body);
  // MEMBER has no timezone of their own, so the time is read in the archive's.
  const exact = saved.json().artifact.dates.exact.date;
  assert.equal(exact.kind, "instant");
  assert.equal(exact.timezone, "America/Toronto");
  assert.equal(exact.instantMs, Date.UTC(2019, 6, 15, 22, 30));
  assert.equal(exact.archiveDay, "2019-07-15");

  // A time with its own offset reads the same anywhere, so it needs no confirmation.
  const withOffset = await botUpload(
    {
      description: "Late night",
      exactDate: "2019-07-15 18:30 -04:00",
      discordAttachmentId: "1311000000000000003",
    },
    file,
  );
  assert.equal(withOffset.statusCode, 201, withOffset.body);
  assert.equal(
    withOffset.json().artifact.dates.exact.date.instantMs,
    Date.UTC(2019, 6, 15, 22, 30),
  );
});

test("the bot may send a Drive link as JSON or as a form, and the service downloads it once", async (t) => {
  const drive = fakeDrive(await imageBytes(t));
  const { h, archiveId, botUpload } = await setup(t, { fetch: drive.fetch });

  const sent = await h.inject({
    method: "POST",
    url: `/api/archives/${archiveId}/artifacts/intake`,
    headers: h.bot(MEMBER.userId),
    payload: {
      description: "Road trip",
      driveLink: DRIVE_LINK,
      submissionGuildId: GUILD_ID,
      submissionChannelId: CHANNEL_ID,
      submissionMessageId: MESSAGE_ID,
    },
  });
  assert.equal(sent.statusCode, 201, sent.body);
  const artifact = sent.json().artifact as ArtifactDetails;
  assert.deepEqual(artifact.source, {
    provider: "drive",
    key: DRIVE_FILE_ID,
    url: DRIVE_LINK,
    resourceKey: null,
  });
  assert.deepEqual(artifact.submission, {
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    messageId: MESSAGE_ID,
  });
  assert.equal(artifact.createdBy, MEMBER.userId);
  assert.equal(artifact.media.originalFilename, "trip.png");
  assert.equal(drive.downloads(), 1);

  const again = await botUpload({ description: "Road trip", driveLink: DRIVE_LINK });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().status, "duplicate");
  assert.equal(again.json().artifact.id, artifact.id);
  assert.equal(drive.downloads(), 1, "a duplicate link is not downloaded again");
});

test("the date preview reads a typed time in the acting contributor's timezone and leaves a plain day alone", async (t) => {
  const { h, archiveId } = await setup(t);
  const preview = (text: string, as = MEMBER.userId) =>
    h.inject({
      method: "GET",
      url: `/api/archives/${archiveId}/date-preview?text=${encodeURIComponent(text)}`,
      headers: h.bot(as),
    });

  const time = await preview("2019-07-15 6:30pm");
  assert.equal(time.statusCode, 200, time.body);
  assert.equal(time.json().assumedZone, true);
  assert.equal(time.json().archiveDay, "2019-07-15");
  assert.deepEqual(time.json().display, {
    local: "Jul 15, 2019, 18:30",
    zone: "America/Toronto",
    offset: "-04:00",
  });

  const day = await preview("2019-08-03");
  assert.equal(day.statusCode, 200, day.body);
  assert.equal(day.json().assumedZone, false);
  assert.equal(day.json().display, null);
  assert.deepEqual(day.json().value, {
    kind: "day",
    originalText: "2019-08-03",
    calendarDay: "2019-08-03",
  });

  // A contributor's own timezone replaces the archive's for them alone.
  const chosen = await h.inject({
    method: "PUT",
    url: "/api/me/timezone",
    headers: h.bot(MEMBER.userId),
    payload: { timeZone: "Europe/London" },
  });
  assert.equal(chosen.statusCode, 200, chosen.body);
  assert.deepEqual((await preview("2019-07-15 6:30pm")).json().display, {
    local: "Jul 15, 2019, 18:30",
    zone: "Europe/London",
    offset: "+01:00",
  });
  assert.equal(
    (await preview("2019-07-15 6:30pm", OWNER.userId)).json().display.zone,
    "America/Toronto",
  );

  assert.equal((await preview("2019-07-15 6:30pm", OTHER.userId)).statusCode, 404);
});
