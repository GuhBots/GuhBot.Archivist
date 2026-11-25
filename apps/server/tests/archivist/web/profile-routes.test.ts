import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import sharp from "sharp";
import { createArchive } from "../../../src/archivist/archives.js";
import { addMember } from "../../../src/archivist/members.js";
import { closeMetadataReader } from "../../../src/archivist/metadata.js";
import { MEMBER, OWNER } from "../helpers/context.js";
import { closeFixtureWriter } from "../helpers/media.js";
import { WEB_SETTINGS, type WebOverrides, webHarness } from "../helpers/web.js";

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

const TOKEN = "test-bot-token";
const DISCORD_ID = "450414958421868554";
const HASH = "0123456789abcdef0123456789abcdef";

/** A small PNG in one color, so two avatars differ by their bytes. */
function pngBytes(color = "#5865f2"): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 12, channels: 3, background: color } })
    .png()
    .toBuffer();
}

/** Discord's API and CDN, answering for one user whose avatar can change. */
function fakeDiscord(state: { avatar: string | null; image: Buffer; status?: number }) {
  const requests: string[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.hostname === "discord.com") {
      assert.equal(new Headers(init.headers).get("authorization"), `Bot ${TOKEN}`);
      if (state.status) return new Response("{}", { status: state.status });
      assert.equal(url.pathname, `/api/v10/users/${DISCORD_ID}`);
      return Response.json({ id: DISCORD_ID, username: "guhbean", avatar: state.avatar });
    }
    assert.equal(url.hostname, "cdn.discordapp.com");
    assert.equal(url.pathname, `/avatars/${DISCORD_ID}/${state.avatar}.png`);
    return new Response(state.image, {
      headers: { "content-type": "image/png", "content-length": String(state.image.length) },
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

async function setup(t: TestContext, overrides: WebOverrides = {}) {
  const h = await webHarness(t, WEB_SETTINGS, overrides);
  const { archiveId } = createArchive(h.context, OWNER, { name: "Hangout" });
  addMember(h.context, OWNER, { archiveId, userId: MEMBER.userId });
  const cookie = h.cookie(MEMBER);
  const call = async (method: "POST" | "PATCH" | "GET", path: string, payload?: unknown) => {
    const response = await h.app.inject({
      method,
      url: path.startsWith("/api/me") ? path : `/api/archives/${archiveId}${path}`,
      headers: { origin: h.origin },
      cookies: { archivist_session: cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: response.statusCode, body: response.body ? response.json() : null };
  };
  const sam = (await call("POST", "/entities/character", { knownName: "Sam" })).body;
  const account = (
    await call("POST", "/entities/account", { kind: "human", label: "sam", characterId: sam.id })
  ).body;
  return { h, archiveId, call, sam, account };
}

test("a history entry's dates and name are edited through its parent", async (t) => {
  const { call, sam } = await setup(t);
  const added = await call("POST", `/entities/character/${sam.id}/history`, {
    kind: "alias",
    expectedVersion: 1,
    name: "Sammy",
  });
  assert.equal(added.status, 201);
  const entry = added.body.entry;
  assert.equal(entry.date, null);

  const edited = await call("PATCH", `/entities/character/${sam.id}/history/${entry.id}`, {
    historyKind: "alias",
    expectedVersion: 2,
    date: "Sep 1 2019",
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.entry.date.archiveDay, "2019-09-01");
  assert.equal(edited.body.record.version, 3);
  assert.equal(edited.body.record.history[0].date.archiveDay, "2019-09-01");

  const stale = await call("PATCH", `/entities/character/${sam.id}/history/${entry.id}`, {
    historyKind: "alias",
    expectedVersion: 2,
    date: null,
  });
  assert.equal(stale.status, 409);
  const wrongKind = await call("PATCH", `/entities/character/${sam.id}/history/${entry.id}`, {
    historyKind: "nonsense",
    expectedVersion: 3,
    date: null,
  });
  assert.equal(wrongKind.status, 400);
});

test("without a bot token, Discord lookups are off and say so", async (t) => {
  const { call, account } = await setup(t);
  const me = await call("GET", "/api/me");
  assert.deepEqual(me.body.features, { discordLookups: false });
  await call("PATCH", `/entities/account/${account.id}`, {
    expectedVersion: 1,
    discordId: DISCORD_ID,
  });
  const refused = await call("POST", `/entities/account/${account.id}/discord-avatar`, {
    expectedVersion: 2,
  });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.details.reason, "discord_lookups_off");
});

test("an account's current Discord avatar is recorded once, dated today, from its Discord ID", async (t) => {
  const first = await pngBytes();
  const state: { avatar: string | null; image: Buffer; status?: number } = {
    avatar: HASH,
    image: first,
  };
  const discord = fakeDiscord(state);
  const { call, sam, account } = await setup(t, { fetch: discord.fetch, discordBotToken: TOKEN });
  assert.deepEqual((await call("GET", "/api/me")).body.features, { discordLookups: true });

  const noId = await call("POST", `/entities/account/${account.id}/discord-avatar`, {
    expectedVersion: 1,
  });
  assert.equal(noId.status, 400);
  assert.equal(noId.body.details.field, "discordId");
  await call("PATCH", `/entities/account/${account.id}`, {
    expectedVersion: 1,
    discordId: DISCORD_ID,
  });

  const added = await call("POST", `/entities/account/${account.id}/discord-avatar`, {
    expectedVersion: 2,
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.status, "added");
  const avatars = added.body.record.history.filter((e: { kind: string }) => e.kind === "avatar");
  assert.equal(avatars.length, 1);
  // The harness's clock is Nov 23, 2026 at noon UTC, which is that day in Toronto too.
  assert.equal(avatars[0].date.archiveDay, "2026-11-23");
  assert.equal(avatars[0].mediaId, added.body.mediaId);
  assert.equal(added.body.record.avatarMediaId, added.body.mediaId);
  // The character now shows it, marked as a stand-in until a main account is named.
  const character = await call("GET", `/entities/character/${sam.id}`);
  assert.deepEqual(character.body.picture, {
    source: "avatar",
    accountId: account.id,
    mediaId: added.body.mediaId,
    standIn: true,
  });

  // The same picture again adds nothing.
  const same = await call("POST", `/entities/account/${account.id}/discord-avatar`, {
    expectedVersion: 3,
  });
  assert.equal(same.body.status, "unchanged");
  assert.equal(same.body.record.version, 3);

  // A new picture is a new observation.
  state.image = await pngBytes("#57c084");
  const changed = await call("POST", `/entities/account/${account.id}/discord-avatar`, {
    expectedVersion: 3,
  });
  assert.equal(changed.body.status, "added");
  assert.equal(changed.body.record.version, 4);

  const stale = await call("POST", `/entities/account/${account.id}/discord-avatar`, {
    expectedVersion: 3,
  });
  assert.equal(stale.status, 409);

  state.avatar = null;
  const plain = await call("POST", `/entities/account/${account.id}/discord-avatar`, {
    expectedVersion: 4,
  });
  assert.equal(plain.body.status, "default_avatar");

  state.status = 404;
  const missing = await call("POST", `/entities/account/${account.id}/discord-avatar`, {
    expectedVersion: 4,
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.details.field, "discordId");
  state.status = 401;
  const refused = await call("POST", `/entities/account/${account.id}/discord-avatar`, {
    expectedVersion: 4,
  });
  assert.equal(refused.status, 503);
});
