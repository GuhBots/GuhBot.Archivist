import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { createArchive, unregisterArchive } from "../../src/archivist/archives.js";
import { createArtifact } from "../../src/archivist/artifacts.js";
import {
  createAccount,
  createChannel,
  createCharacter,
  createServer,
} from "../../src/archivist/entities.js";
import { createEvent, type EventLinkInput } from "../../src/archivist/events.js";
import { addHistory } from "../../src/archivist/history.js";
import { createStagingFolder, stageMedia } from "../../src/archivist/media.js";
import { addMember, removeMember } from "../../src/archivist/members.js";
import { closeMetadataReader } from "../../src/archivist/metadata.js";
import { createRequest } from "../../src/archivist/requests.js";
import { closeFixtureWriter, writeWav } from "../archivist/helpers/media.js";
import {
  MEMBER,
  NOW,
  OTHER,
  OWNER,
  serviceHarness,
  type ServiceHarness,
  testConfig,
} from "./harness.js";

/**
 * The routes the Discord bot needs beyond the website's: the archive a
 * command uses when none is given, typed names and short IDs, the summaries
 * replies show, and delete blockers. Requests carry the bot's credential and
 * act for MEMBER unless a test says otherwise.
 */

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

const SAMWISE_DISCORD_ID = "175928847299117063";
const HANGOUT_DISCORD_ID = "727573539904815224";
const GENERAL_DISCORD_ID = "727573539904815230";
/** A well-formed ID that names no archive or record. */
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

type Hit = { id: string; label: string };

const short = (id: string) => id.slice(0, 8);

async function seed(t: TestContext) {
  const h = await serviceHarness(t);
  const { context } = h;
  const { archiveId } = createArchive(context, OWNER, { name: "Hangout" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  // MEMBER is not on this archive's whitelist.
  const elsewhere = createArchive(context, OWNER, { name: "Elsewhere" }).archiveId;
  const character = (
    knownName: string,
    extra: { realName?: string; birthDay?: string; metInPerson?: string } = {},
  ) => createCharacter(context, MEMBER, { archiveId, knownName, ...extra }).id;
  const sam = character("Sam", {
    realName: "Samuel Hart",
    birthDay: "2001-04-12",
    metInPerson: "yes",
  });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "alias",
    parentId: sam,
    expectedVersion: 1,
    name: "Sammy",
  });
  const lee = character("Lee");
  // Two characters share a name, so picking either one takes its short ID.
  const alexes = [character("Alex"), character("Alex")].sort();
  const samwise = createAccount(context, MEMBER, {
    archiveId,
    kind: "human",
    label: "samwise",
    discordId: SAMWISE_DISCORD_ID,
    characterId: sam,
  }).id;
  const hangout = createServer(context, MEMBER, {
    archiveId,
    label: "The Hangout",
    discordId: HANGOUT_DISCORD_ID,
    color: "#5865f2",
  }).id;
  const general = createChannel(context, MEMBER, {
    archiveId,
    kind: "guild_channel",
    label: "general",
    serverId: hangout,
    discordId: GENERAL_DISCORD_ID,
  }).id;
  const trip = createChannel(context, MEMBER, {
    archiveId,
    kind: "group_chat",
    label: "Road Trip",
    color: "#eb459e",
  }).id;
  return { h, archiveId, elsewhere, sam, lee, alexes, samwise, hangout, general, trip };
}

/** An event MEMBER creates, lasting from `start` to `end` when an end is given. */
function addEvent(
  h: ServiceHarness,
  archiveId: string,
  input: {
    title: string;
    start: string;
    end?: string;
    description?: string;
    links?: EventLinkInput;
  },
): string {
  return createEvent(h.context, MEMBER, {
    archiveId,
    description: "Notes",
    dateKind: input.end ? "duration" : "single",
    certainty: "exact",
    ...input,
  }).id;
}

let attachmentCounter = 0;

/** Archives a short sound clip as MEMBER, under a Discord attachment ID no other artifact uses. */
async function addArtifact(
  h: ServiceHarness,
  archiveId: string,
  description: string,
): Promise<string> {
  const file = join(createStagingFolder(h.context), "original");
  writeWav(file);
  const media = await stageMedia(h.context, { file, originalFilename: "clip.wav" });
  attachmentCounter += 1;
  return createArtifact(h.context, MEMBER, {
    archiveId,
    description,
    media,
    source: {
      provider: "discord_attachment",
      key: `9${String(attachmentCounter).padStart(17, "0")}`,
    },
  }).artifact.id;
}

function botGet(h: ServiceHarness, url: string, userId = MEMBER.userId) {
  return h.inject({ method: "GET", url, headers: h.bot(userId) });
}

/** Asks for the user's archive selection as the bot does, which sends no Origin header. */
function select(h: ServiceHarness, userId: string, body?: object) {
  return h.inject({
    method: "POST",
    url: "/api/me/archive-selection",
    headers: h.bot(userId),
    ...(body === undefined ? {} : { payload: body }),
  });
}

/** A query string that repeats a key for each value in a list. */
function query(params: Record<string, string | string[]>): string {
  return Object.entries(params)
    .flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map((item) => `${key}=${encodeURIComponent(item)}`),
    )
    .join("&");
}

function searcher(h: ServiceHarness, archiveId: string) {
  return async (kind: string, q: string, limit?: string): Promise<Hit[]> => {
    const params: Record<string, string> = { kind, q };
    if (limit !== undefined) params.limit = limit;
    return ok(await botGet(h, `/api/archives/${archiveId}/lookup/search?${query(params)}`)).items;
  };
}

function ok(response: LightMyRequestResponse) {
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

/** Checks a refusal's status and code, and returns its body. */
function refused(response: LightMyRequestResponse, status: number, code: string, what = "") {
  const message = `${what} ${response.body}`.trim();
  assert.equal(response.statusCode, status, message);
  const body = response.json();
  assert.equal(body.code, code, message);
  return body;
}

test("an archive named in a selection is checked, remembered, and used when a later command omits it", async (t) => {
  const { h, archiveId, elsewhere } = await seed(t);
  const hangout = { archiveId, name: "Hangout" };
  const unchosen = refused(await select(h, MEMBER.userId, {}), 400, "invalid_input");
  assert.deepEqual(unchosen.details, { field: "archive", reason: "archive_required" });

  assert.deepEqual(ok(await select(h, MEMBER.userId, { archiveId })), hangout);
  for (const omitted of [{}, { archiveId: "" }, { archiveId: null }, undefined]) {
    assert.deepEqual(ok(await select(h, MEMBER.userId, omitted)), hangout, JSON.stringify(omitted));
  }

  // Each contributor has their own selection, and a later choice replaces an earlier one.
  refused(await select(h, OWNER.userId), 400, "invalid_input");
  ok(await select(h, OWNER.userId, { archiveId: elsewhere }));
  assert.deepEqual(ok(await select(h, OWNER.userId)), { archiveId: elsewhere, name: "Elsewhere" });
  assert.deepEqual(ok(await select(h, MEMBER.userId)), hangout);
  ok(await select(h, OWNER.userId, { archiveId }));
  assert.deepEqual(ok(await select(h, OWNER.userId)), hangout);

  refused(await select(h, MEMBER.userId, ["not", "an", "object"]), 400, "invalid_input");
});

test("a selection naming an archive the contributor cannot open answers not found and keeps the earlier one", async (t) => {
  const { h, archiveId, elsewhere } = await seed(t);
  ok(await select(h, MEMBER.userId, { archiveId }));
  // An archive they are not on looks the same as one that does not exist.
  for (const other of [elsewhere, UNKNOWN_ID, "not-an-archive", 42]) {
    refused(
      await select(h, MEMBER.userId, { archiveId: other }),
      404,
      "archive_not_found",
      String(other),
    );
  }
  assert.deepEqual(ok(await select(h, MEMBER.userId)), { archiveId, name: "Hangout" });

  // Someone on no whitelist cannot select it, so nothing is remembered for them.
  refused(await select(h, OTHER.userId, { archiveId }), 404, "archive_not_found");
  const unchosen = refused(await select(h, OTHER.userId), 400, "invalid_input");
  assert.equal(unchosen.details.reason, "archive_required");
});

test("losing access to the remembered archive or unregistering it requires a new selection", async (t) => {
  const { h, archiveId, elsewhere } = await seed(t);
  ok(await select(h, MEMBER.userId, { archiveId }));
  removeMember(h.context, OWNER, { archiveId, userId: MEMBER.userId });
  const revoked = refused(await select(h, MEMBER.userId), 400, "invalid_input");
  assert.equal(revoked.details.reason, "archive_required");
  refused(await select(h, MEMBER.userId, { archiveId }), 404, "archive_not_found");

  // The owner can open every registered archive, so only unregistering ends their selection.
  ok(await select(h, OWNER.userId, { archiveId: elsewhere }));
  unregisterArchive(h.context, OWNER, { archiveId });
  assert.deepEqual(ok(await select(h, OWNER.userId)), { archiveId: elsewhere, name: "Elsewhere" });
  unregisterArchive(h.context, OWNER, { archiveId: elsewhere });
  const unregistered = refused(await select(h, OWNER.userId), 400, "invalid_input");
  assert.equal(unregistered.details.reason, "archive_required");
  refused(await select(h, OWNER.userId, { archiveId: elsewhere }), 404, "archive_not_found");
});

test("character lookups resolve known names, aliases, and short ID tags in the order typed", async (t) => {
  const { h, archiveId, sam, lee, alexes } = await seed(t);
  const lookup = async (names?: string) =>
    ok(
      await botGet(
        h,
        `/api/archives/${archiveId}/lookup/characters${names === undefined ? "" : `?${query({ names })}`}`,
      ),
    );

  assert.deepEqual(await lookup(" sam, LEE "), {
    characters: [
      { id: sam, knownName: "Sam" },
      { id: lee, knownName: "Lee" },
    ],
  });
  // An alias gives the character's known name, and a character named twice is listed once.
  assert.deepEqual(await lookup("Sammy, Sam"), { characters: [{ id: sam, knownName: "Sam" }] });
  assert.deepEqual(await lookup(""), { characters: [] });
  assert.deepEqual(await lookup(), { characters: [] });

  // A shared name is picked with the short ID autocomplete adds, in either case.
  const [first, second] = alexes as [string, string];
  assert.deepEqual(await lookup(`Alex (${short(second).toUpperCase()}), Alex (${short(first)})`), {
    characters: [
      { id: second, knownName: "Alex" },
      { id: first, knownName: "Alex" },
    ],
  });
});

test("character lookups refuse unknown and shared names with a message naming them", async (t) => {
  const { h, archiveId, alexes } = await seed(t);
  const lookup = async (names: string) =>
    botGet(h, `/api/archives/${archiveId}/lookup/characters?${query({ names })}`);

  const unknown = refused(await lookup("Sam, Alicia"), 400, "invalid_input");
  assert.deepEqual(unknown.details, { field: "characters", name: "Alicia" });
  assert.match(unknown.message, /Alicia/);

  const shared = refused(await lookup("alex"), 400, "invalid_input");
  assert.deepEqual(shared.details, { field: "characters", name: "alex" });
  // The message repeats the name as typed, with a short ID showing how to pick one.
  assert.match(shared.message, new RegExp(`alex \\((${alexes.map(short).join("|")})\\)`));

  const untagged = refused(await lookup(`Alex (${short(UNKNOWN_ID)})`), 404, "not_found");
  assert.match(untagged.message, new RegExp(short(UNKNOWN_ID)));

  const long = refused(await lookup("a".repeat(201)), 400, "invalid_input");
  assert.equal(long.details.field, "names");
});

test("event lookups resolve titles and short IDs, and refuse unknown or shared titles by name", async (t) => {
  const { h, archiveId } = await seed(t);
  const launch = addEvent(h, archiveId, { title: "Launch party", start: "2019-08-03" });
  const summer = addEvent(h, archiveId, {
    title: "Summer season",
    start: "2020-06-01",
    end: "2020-08-31",
  });
  const movies = [
    addEvent(h, archiveId, { title: "Movie night", start: "2020-01-10" }),
    addEvent(h, archiveId, { title: "Movie night", start: "2020-02-14" }),
  ];
  const lookup = async (names: string) =>
    botGet(h, `/api/archives/${archiveId}/lookup/events?${query({ names })}`);

  assert.deepEqual(ok(await lookup(`launch PARTY, ${short(summer)}`)), {
    events: [
      { id: launch, title: "Launch party" },
      { id: summer, title: "Summer season" },
    ],
  });
  // A shared title is picked with its short ID.
  assert.deepEqual(
    ok(await lookup(`Movie night (${short(movies[1]!)}), Movie night (${short(movies[0]!)})`)),
    {
      events: [
        { id: movies[1], title: "Movie night" },
        { id: movies[0], title: "Movie night" },
      ],
    },
  );
  assert.deepEqual(ok(await botGet(h, `/api/archives/${archiveId}/lookup/events`)), {
    events: [],
  });

  const shared = refused(await lookup("Movie night"), 400, "invalid_input");
  assert.deepEqual(shared.details, { field: "events", name: "Movie night" });
  assert.match(shared.message, /Movie night/);
  const unknown = refused(await lookup("Launch party, Picnic"), 400, "invalid_input");
  assert.deepEqual(unknown.details, { field: "events", name: "Picnic" });
  assert.match(unknown.message, /Picnic/);
  refused(await lookup(short(UNKNOWN_ID)), 404, "not_found");
  assert.equal(refused(await lookup("a".repeat(201)), 400, "invalid_input").details.field, "names");
});

test("character suggestions complete the last name typed and skip names already chosen", async (t) => {
  const { h, archiveId, alexes } = await seed(t);
  const suggest = async (typed?: string) =>
    ok(
      await botGet(
        h,
        `/api/archives/${archiveId}/lookup/character-suggestions${typed === undefined ? "" : `?${query({ typed })}`}`,
      ),
    ).suggestions as { name: string; value: string }[];
  const values = async (typed: string) => (await suggest(typed)).map((choice) => choice.value);
  const alexChoices = alexes.map((id) => `Alex (${short(id)})`);

  // Names that start with the text come before names that only contain it.
  assert.deepEqual(await values("Sam, le"), [
    "Sam, Lee",
    ...alexChoices.map((choice) => `Sam, ${choice}`),
  ]);
  // An alias suggests the character's known name.
  assert.deepEqual(await values("samm"), ["Sam"]);
  assert.deepEqual(await values("Sam, sa"), []);
  assert.deepEqual(await values(`${alexChoices[0]}, al`), [`${alexChoices[0]}, ${alexChoices[1]}`]);
  // Before anything is typed, every character is offered, in name order.
  assert.deepEqual(
    await suggest(),
    [...alexChoices, "Lee", "Sam"].map((name) => ({ name, value: name })),
  );

  const long = await botGet(
    h,
    `/api/archives/${archiveId}/lookup/character-suggestions?${query({ typed: "a".repeat(201) })}`,
  );
  assert.equal(refused(long, 400, "invalid_input").details.field, "typed");
});

test("searches find characters, accounts, servers, and channels by name, alias, Discord ID, or ID prefix", async (t) => {
  const { h, archiveId, sam, lee, alexes, samwise, hangout, general, trip } = await seed(t);
  const search = searcher(h, archiveId);
  const alexHits = alexes.map((id) => ({ id, label: "Alex" }));

  assert.deepEqual(await search("character", "SAMMY"), [{ id: sam, label: "Sam" }]);
  assert.deepEqual(await search("character", "ale"), alexHits);
  assert.deepEqual(await search("character", lee.slice(0, 6)), [{ id: lee, label: "Lee" }]);
  // Without text, the first records in name order, up to the limit.
  assert.deepEqual(await search("character", "", "2"), alexHits);
  assert.deepEqual(
    (await search("character", "", "100")).map((hit) => hit.label),
    ["Alex", "Alex", "Lee", "Sam"],
  );
  assert.deepEqual(await search("account", "SAMW"), [{ id: samwise, label: "samwise" }]);
  assert.deepEqual(await search("account", SAMWISE_DISCORD_ID), [
    { id: samwise, label: "samwise" },
  ]);
  assert.deepEqual(await search("server", "hangout"), [{ id: hangout, label: "The Hangout" }]);
  assert.deepEqual(await search("server", HANGOUT_DISCORD_ID), [
    { id: hangout, label: "The Hangout" },
  ]);
  // Channels say whether they are group chats or which server they are in.
  assert.deepEqual(await search("channel", "ROAD"), [
    { id: trip, label: "Road Trip", detail: "group chat" },
  ]);
  assert.deepEqual(await search("channel", GENERAL_DISCORD_ID), [
    { id: general, label: "general", detail: "The Hangout" },
  ]);
  assert.deepEqual(await search("channel", short(general)), [
    { id: general, label: "general", detail: "The Hangout" },
  ]);
  assert.deepEqual(await search("server", "nowhere"), []);
});

test("searches find artifacts and requests newest first and events oldest first, by text or ID prefix", async (t) => {
  const { h, archiveId, sam } = await seed(t);
  const search = searcher(h, archiveId);
  const photo = await addArtifact(h, archiveId, "First meetup photo");
  h.clock.ms += 60_000;
  const clip = await addArtifact(h, archiveId, "Road trip clip");
  const launch = addEvent(h, archiveId, { title: "Launch party", start: "2019-08-03" });
  const summer = addEvent(h, archiveId, {
    title: "Summer season",
    description: "A shared world",
    start: "2020-06-01",
    end: "2020-08-31",
  });
  const older = createRequest(h.context, MEMBER, {
    archiveId,
    description: "Photos from the summer meetup",
    characters: [sam],
    constraint: { kind: "approximate_day", day: "2020-07-01" },
  }).id;
  h.clock.ms += 60_000;
  const newer = createRequest(h.context, MEMBER, {
    archiveId,
    description: "Recording of the launch stream",
    characters: [sam],
    constraint: { kind: "before_event", eventId: launch },
  }).id;

  const photoHit = { id: photo, label: "First meetup photo" };
  const clipHit = { id: clip, label: "Road trip clip" };
  assert.deepEqual(await search("artifact", ""), [clipHit, photoHit]);
  assert.deepEqual(await search("artifact", "", "1"), [clipHit]);
  assert.deepEqual(await search("artifact", "MEETUP"), [photoHit]);
  assert.deepEqual(await search("artifact", short(photo)), [photoHit]);

  const launchHit = { id: launch, label: "Launch party" };
  const summerHit = { id: summer, label: "Summer season" };
  assert.deepEqual(await search("event", ""), [launchHit, summerHit]);
  // Events match their description as well as their title.
  assert.deepEqual(await search("event", "shared WORLD"), [summerHit]);
  assert.deepEqual(await search("event", short(summer)), [summerHit]);

  const olderHit = { id: older, label: "Photos from the summer meetup" };
  const newerHit = { id: newer, label: "Recording of the launch stream" };
  assert.deepEqual(await search("request", ""), [newerHit, olderHit]);
  assert.deepEqual(await search("request", "Summer"), [olderHit]);
  assert.deepEqual(await search("request", short(newer)), [newerHit]);
});

test("searches refuse an unknown kind, a limit outside 1 to 100, and text over 200 characters", async (t) => {
  const { h, archiveId } = await seed(t);
  const cases: [Record<string, string>, string][] = [
    [{ kind: "planet" }, "kind"],
    [{ q: "Sam" }, "kind"],
    [{ kind: "character", limit: "0" }, "limit"],
    [{ kind: "character", limit: "101" }, "limit"],
    [{ kind: "character", limit: "2.5" }, "limit"],
    [{ kind: "character", limit: "ten" }, "limit"],
    [{ kind: "character", q: "a".repeat(201) }, "q"],
  ];
  for (const [params, field] of cases) {
    const response = await botGet(h, `/api/archives/${archiveId}/lookup/search?${query(params)}`);
    const body = refused(response, 400, "invalid_input", query(params));
    assert.equal(body.details.field, field, query(params));
  }
});

test("name lookups give characters' and events' names by ID, and null for IDs this archive lacks", async (t) => {
  const { h, archiveId, elsewhere, sam, lee } = await seed(t);
  const launch = addEvent(h, archiveId, { title: "Launch party", start: "2019-08-03" });
  // A character in another archive is unknown in this one.
  const stranger = createCharacter(h.context, OWNER, {
    archiveId: elsewhere,
    knownName: "Stranger",
  }).id;
  const names = (params: Record<string, string | string[]>) =>
    botGet(h, `/api/archives/${archiveId}/lookup/names?${query(params)}`);

  assert.deepEqual(
    ok(await names({ character: [sam, lee, stranger], event: [launch, UNKNOWN_ID] })),
    {
      characters: { [sam]: "Sam", [lee]: "Lee", [stranger]: null },
      events: { [launch]: "Launch party", [UNKNOWN_ID]: null },
    },
  );
  assert.deepEqual(ok(await names({ event: launch })), {
    characters: {},
    events: { [launch]: "Launch party" },
  });
  assert.deepEqual(ok(await names({})), { characters: {}, events: {} });

  // At most 100 IDs at a time, counting both kinds together.
  const ids = Array.from({ length: 101 }, (_, index) => `missing-${index}`);
  const hundred = ok(await names({ character: ids.slice(0, 60), event: ids.slice(60, 100) }));
  assert.equal(Object.keys(hundred.characters).length + Object.keys(hundred.events).length, 100);
  refused(await names({ character: ids.slice(0, 60), event: ids.slice(60) }), 400, "invalid_input");
});

test("summaries show each kind's own fields as labeled values and accept short IDs", async (t) => {
  const { h, archiveId, elsewhere, sam, lee, samwise, hangout, general, trip } = await seed(t);
  const thread = createChannel(h.context, MEMBER, {
    archiveId,
    kind: "thread",
    label: "planning",
    serverId: hangout,
    parentChannelId: general,
  }).id;
  const helper = createAccount(h.context, MEMBER, { archiveId, kind: "bot", label: "Helper" }).id;
  const lurker = createAccount(h.context, MEMBER, { archiveId, kind: "human", label: "lurker" }).id;
  const stranger = createCharacter(h.context, OWNER, {
    archiveId: elsewhere,
    knownName: "Stranger",
  }).id;
  const summary = (kind: string, id: string) =>
    botGet(h, `/api/archives/${archiveId}/entities/${kind}/${id}/summary`);
  const fields = async (kind: string, id: string) => ok(await summary(kind, short(id))).fields;

  assert.deepEqual(ok(await summary("character", short(sam).toUpperCase())), {
    kind: "character",
    id: sam,
    // Adding the alias was an edit of the character.
    version: 2,
    createdAt: NOW.toISOString(),
    createdBy: MEMBER.userId,
    name: "Sam",
    fields: [
      ["Real name", "Samuel Hart"],
      ["Aliases", "Sammy"],
      ["Birth day", "Apr 12, 2001 (age 25)"],
      ["Met in person", "yes"],
      ["Accounts", "samwise"],
    ],
  });
  // Empty fields are left out.
  assert.deepEqual(await fields("character", lee), [["Met in person", "unknown"]]);
  assert.deepEqual(await fields("account", samwise), [
    ["Kind", "human"],
    ["Discord ID", SAMWISE_DISCORD_ID],
    ["Character", "Sam"],
  ]);
  assert.deepEqual(await fields("account", lurker), [
    ["Kind", "human"],
    ["Character", "Not linked yet"],
  ]);
  assert.deepEqual(await fields("account", helper), [["Kind", "bot"]]);
  assert.deepEqual(await fields("server", hangout), [
    ["Discord ID", HANGOUT_DISCORD_ID],
    ["Lane color", "#5865f2"],
  ]);
  assert.deepEqual(await fields("channel", general), [
    ["Kind", "guild channel"],
    ["Server", "The Hangout"],
    ["Discord ID", GENERAL_DISCORD_ID],
  ]);
  assert.deepEqual(await fields("channel", thread), [
    ["Kind", "thread"],
    ["Server", "The Hangout"],
    ["Parent channel", "general"],
  ]);
  assert.deepEqual(await fields("channel", trip), [
    ["Kind", "group chat"],
    ["Lane color", "#eb459e"],
  ]);

  refused(await summary("planet", sam), 404, "not_found");
  refused(await summary("character", short(UNKNOWN_ID)), 404, "not_found");
  // A record of another kind, or in another archive, is not found here.
  refused(await summary("account", sam), 404, "not_found");
  refused(await summary("character", stranger), 404, "not_found");
  refused(await summary("character", sam.slice(0, 7)), 400, "invalid_input");
});

test("entity deletion checks name what still links to a record and pass records nothing links to", async (t) => {
  const { h, archiveId, sam, lee, samwise, hangout, general, trip } = await seed(t);
  const summer = addEvent(h, archiveId, {
    title: "Summer season",
    start: "2020-06-01",
    end: "2020-08-31",
    links: { characters: [sam], servers: [hangout] },
  });
  createRequest(h.context, MEMBER, {
    archiveId,
    description: "Photos from after the season",
    characters: [sam],
    constraint: { kind: "after_event", eventId: summer },
  });
  createChannel(h.context, MEMBER, {
    archiveId,
    kind: "thread",
    label: "planning",
    serverId: hangout,
    parentChannelId: general,
  });
  addHistory(h.context, MEMBER, {
    archiveId,
    kind: "membership",
    parentId: samwise,
    expectedVersion: 1,
    targetId: hangout,
  });
  const check = (kind: string, id: string) =>
    botGet(h, `/api/archives/${archiveId}/entities/${kind}/${id}/deletion-check`);

  const blocked: [kind: string, id: string, references: Record<string, number>][] = [
    ["character", sam, { events: 1, "missing-media requests": 1, accounts: 1 }],
    ["account", samwise, { "server memberships": 1 }],
    // The thread belongs to the server as well as to its parent channel.
    ["server", hangout, { events: 1, channels: 2, "server memberships": 1 }],
    ["channel", general, { threads: 1 }],
  ];
  for (const [kind, id, references] of blocked) {
    const body = refused(await check(kind, short(id)), 409, "reference_blocked", kind);
    assert.deepEqual(body.details, { record: kind, id, references }, kind);
    for (const [label, count] of Object.entries(references)) {
      assert.ok(body.message.includes(`${count} ${label}`), body.message);
    }
  }
  assert.deepEqual(ok(await check("character", short(lee))), { id: lee, deletable: true });
  assert.deepEqual(ok(await check("channel", trip)), { id: trip, deletable: true });

  refused(await check("planet", lee), 404, "not_found");
  refused(await check("character", short(UNKNOWN_ID)), 404, "not_found");
  refused(await check("character", "abc"), 400, "invalid_input");
});

test("event deletion checks refuse an event that missing-media requests use as their date", async (t) => {
  const { h, archiveId, sam } = await seed(t);
  const summer = addEvent(h, archiveId, {
    title: "Summer season",
    start: "2020-06-01",
    end: "2020-08-31",
  });
  const launch = addEvent(h, archiveId, {
    title: "Launch party",
    start: "2019-08-03",
    links: { characters: [sam] },
  });
  for (const kind of ["before_event", "after_event"]) {
    createRequest(h.context, MEMBER, {
      archiveId,
      description: `Clips dated ${kind}`,
      characters: [sam],
      events: [launch],
      constraint: { kind, eventId: summer },
    });
  }
  const check = (id: string) => botGet(h, `/api/archives/${archiveId}/events/${id}/deletion-check`);

  const blocked = refused(await check(short(summer)), 409, "reference_blocked");
  assert.deepEqual(blocked.details, {
    record: "event",
    id: summer,
    references: { "missing-media requests": 2 },
  });
  assert.match(blocked.message, /2 missing-media requests use this event as their date/);
  // Requests that only list the event, and characters linked to it, do not block deleting it.
  assert.deepEqual(ok(await check(short(launch))), { id: launch, deletable: true });

  refused(await check(short(UNKNOWN_ID)), 404, "not_found");
  refused(await check("abc"), 400, "invalid_input");
});

test("every lookup, summary, and deletion check answers not found to someone who cannot open the archive", async (t) => {
  const { h, archiveId, elsewhere, sam, lee } = await seed(t);
  const launch = addEvent(h, archiveId, { title: "Launch party", start: "2019-08-03" });
  // OTHER is on another archive's whitelist, which gives no access to this one.
  addMember(h.context, OWNER, { archiveId: elsewhere, userId: OTHER.userId });
  const routes = (archive: string) =>
    [
      "lookup/characters?names=Sam",
      `lookup/events?${query({ names: "Launch party" })}`,
      "lookup/character-suggestions?typed=Sa",
      "lookup/search?kind=character&q=Sam",
      `lookup/names?character=${sam}&event=${launch}`,
      `entities/character/${sam}/summary`,
      `entities/character/${lee}/deletion-check`,
      `events/${launch}/deletion-check`,
    ].map((path) => `/api/archives/${archive}/${path}`);

  for (const url of routes(archiveId)) {
    assert.equal((await botGet(h, url)).statusCode, 200, url);
    // The owner opens every archive without a whitelist entry.
    assert.equal((await botGet(h, url, OWNER.userId)).statusCode, 200, url);
    refused(await botGet(h, url, OTHER.userId), 404, "archive_not_found", url);
  }
  // An archive the member is not on looks the same as one that does not exist.
  for (const archive of [elsewhere, UNKNOWN_ID, "not-an-archive"]) {
    for (const url of routes(archive)) {
      refused(await botGet(h, url), 404, "archive_not_found", url);
    }
  }
  // Removing the member applies to their very next request.
  removeMember(h.context, OWNER, { archiveId, userId: MEMBER.userId });
  for (const url of routes(archiveId)) {
    refused(await botGet(h, url), 404, "archive_not_found", url);
  }

  // A request with no credential, or the bot's credential with no acting user, reaches no archive.
  const url = routes(archiveId)[0]!;
  refused(await h.inject({ method: "GET", url }), 401, "no_session");
  const actorless = refused(
    await h.inject({ method: "GET", url, headers: h.botOnly() }),
    400,
    "invalid_input",
  );
  assert.equal(actorless.details.reason, "acting_user_required");
});

test("a signed-in browser may use the lookups but must send the site's origin to change its selection", async (t) => {
  const { h, archiveId, sam } = await seed(t);
  const cookies = { archivist_session: h.cookie(MEMBER) };
  const found = await h.inject({
    method: "GET",
    url: `/api/archives/${archiveId}/lookup/characters?names=Sam`,
    cookies,
  });
  assert.deepEqual(ok(found), { characters: [{ id: sam, knownName: "Sam" }] });

  const selection = {
    method: "POST" as const,
    url: "/api/me/archive-selection",
    cookies,
    payload: { archiveId },
  };
  const crossSite = refused(await h.inject(selection), 403, "forbidden");
  assert.equal(crossSite.details.reason, "cross_origin");
  assert.deepEqual(ok(await h.inject({ ...selection, headers: { origin: h.origin } })), {
    archiveId,
    name: "Hangout",
  });
});

test("the bot's routes answer under the website's base path", async (t) => {
  const web = { ...testConfig("unused").web, baseUrl: "http://localhost:3000/archivist" };
  const h = await serviceHarness(t, { config: { web } });
  const { archiveId } = createArchive(h.context, OWNER, { name: "Hangout" });
  addMember(h.context, OWNER, { archiveId, userId: MEMBER.userId });
  const sam = createCharacter(h.context, MEMBER, { archiveId, knownName: "Sam" }).id;

  const selected = await h.inject({
    method: "POST",
    url: "/archivist/api/me/archive-selection",
    headers: h.bot(MEMBER.userId),
    payload: { archiveId },
  });
  assert.deepEqual(ok(selected), { archiveId, name: "Hangout" });
  const lookup = `api/archives/${archiveId}/lookup/characters?names=Sam`;
  assert.deepEqual(ok(await botGet(h, `/archivist/${lookup}`)), {
    characters: [{ id: sam, knownName: "Sam" }],
  });
  refused(await botGet(h, `/${lookup}`), 404, "not_found");
});
