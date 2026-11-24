import assert from "node:assert/strict";
import { test } from "node:test";
import { createArchive } from "../../src/archivist/archives.js";
import { ArchivistError } from "../../src/archivist/errors.js";
import { addMember } from "../../src/archivist/members.js";
import { checkServiceConfig, parseOwnerIds, readConfig } from "../../src/service/config.js";
import { makeTempDir } from "../archivist/helpers/temp-dir.js";
import { MEMBER, OTHER, OWNER, SERVICE_TOKEN, serviceHarness, testConfig } from "./harness.js";

function fails(reason: string) {
  return (error: unknown) => error instanceof ArchivistError && error.details.reason === reason;
}

test("settings come from the environment, and serve refuses missing owners and short tokens", (t) => {
  const config = readConfig({
    DATA_DIR: "/srv/archivist",
    ARCHIVIST_OWNER_IDS: `${OWNER.userId}, ${MEMBER.userId}`,
    ARCHIVIST_SERVICE_TOKEN: " token-with-spaces-trimmed ",
  });
  assert.equal(config.dataDir, "/srv/archivist");
  assert.equal(config.web.host, "127.0.0.1");
  assert.equal(config.web.port, 3000);
  assert.equal(config.web.baseUrl, "http://localhost:3000");
  assert.deepEqual([...config.ownerIds], [OWNER.userId, MEMBER.userId]);
  assert.equal(config.serviceToken, "token-with-spaces-trimmed");
  assert.equal(readConfig({}).serviceToken, null);

  assert.throws(() => parseOwnerIds("123, not-an-id"), fails("invalid_owner_ids"));
  assert.throws(() => readConfig({ ARCHIVIST_PORT: "http" }), fails("invalid_port"));

  const dataDir = makeTempDir(t);
  assert.doesNotThrow(() => checkServiceConfig(testConfig(dataDir)));
  assert.throws(
    () => checkServiceConfig(testConfig(dataDir, { ownerIds: new Set() })),
    fails("missing_owner_ids"),
  );
  assert.throws(
    () => checkServiceConfig(testConfig(dataDir, { serviceToken: "short" })),
    fails("short_service_token"),
  );
  assert.doesNotThrow(() => checkServiceConfig(testConfig(dataDir, { serviceToken: null })));
});

test("the bot acts for the user it names, with that user's own access and no more", async (t) => {
  const h = await serviceHarness(t);
  const { archiveId } = createArchive(h.context, OWNER, { name: "Hangout" });
  addMember(h.context, OWNER, { archiveId, userId: MEMBER.userId });

  const me = await h.inject({ method: "GET", url: "/api/me", headers: h.bot(MEMBER.userId) });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().via, "service");
  assert.equal(me.json().isOwner, false);
  assert.equal(me.json().sessionExpires, null);
  assert.equal(me.headers["set-cookie"], undefined, "the bot never gets a session");

  // Nothing the bot sends makes a non-owner an owner.
  const created = await h.inject({
    method: "POST",
    url: "/api/archives",
    headers: h.bot(MEMBER.userId, { "x-archivist-owner": "true" }),
    payload: { name: "Mine", isOwner: true },
  });
  assert.equal(created.statusCode, 403);

  // Someone on no whitelist sees no archives at all.
  const other = await h.inject({
    method: "GET",
    url: "/api/archives",
    headers: h.bot(OTHER.userId),
  });
  assert.deepEqual(other.json(), { archives: [] });
  const hidden = await h.inject({
    method: "GET",
    url: `/api/archives/${archiveId}`,
    headers: h.bot(OTHER.userId),
  });
  assert.equal(hidden.statusCode, 404);

  // Without a valid user to act for, the bot is refused.
  for (const user of [undefined, "", "not-a-user", "1".repeat(30)]) {
    const headers: Record<string, string> = { authorization: `Bearer ${SERVICE_TOKEN}` };
    if (user !== undefined) headers["x-archivist-user"] = user;
    const refused = await h.inject({ method: "GET", url: "/api/me", headers });
    assert.equal(refused.statusCode, 400, String(user));
    assert.equal(refused.json().details.reason, "acting_user_required");
  }
});

test("a wrong token is refused outright, and a token with a session cookie is ambiguous", async (t) => {
  const h = await serviceHarness(t);
  const { archiveId } = createArchive(h.context, OWNER, { name: "Hangout" });
  addMember(h.context, OWNER, { archiveId, userId: MEMBER.userId });
  const cookie = h.cookie(MEMBER);

  const wrong = await h.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: "Bearer not-the-token", "x-archivist-user": MEMBER.userId },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().details.reason, "invalid_service_token");

  const mixed = await h.inject({
    method: "GET",
    url: "/api/me",
    headers: h.bot(MEMBER.userId),
    cookies: { archivist_session: cookie },
  });
  assert.equal(mixed.statusCode, 400);
  assert.equal(mixed.json().details.reason, "mixed_credentials");

  // Another scheme, such as a proxy's Basic sign-in, leaves the browser's session in charge.
  const basic = await h.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: "Basic dXNlcjpwYXNz", "x-archivist-user": OWNER.userId },
    cookies: { archivist_session: cookie },
  });
  assert.equal(basic.statusCode, 200);
  assert.equal(basic.json().user.id, MEMBER.userId, "the header cannot pick another user");
  assert.equal(basic.json().via, "session");
});

test("the bot's changes need no Origin, while a browser's still do", async (t) => {
  const h = await serviceHarness(t);
  const bot = await h.inject({
    method: "PUT",
    url: "/api/me/timezone",
    headers: h.bot(OWNER.userId),
    payload: { timeZone: "Europe/London" },
  });
  assert.equal(bot.statusCode, 200, bot.body);

  const cookie = h.cookie(OWNER);
  const crossSite = await h.inject({
    method: "PUT",
    url: "/api/me/timezone",
    headers: { origin: "https://evil.example" },
    cookies: { archivist_session: cookie },
    payload: { timeZone: "Europe/Paris" },
  });
  assert.equal(crossSite.statusCode, 403);
  const sameSite = await h.inject({
    method: "PUT",
    url: "/api/me/timezone",
    headers: { origin: h.origin },
    cookies: { archivist_session: cookie },
    payload: { timeZone: "Europe/Paris" },
  });
  assert.equal(sameSite.statusCode, 200);
});

test("without a service token the bot is refused and browsers keep working", async (t) => {
  const h = await serviceHarness(t, { config: { serviceToken: null } });
  const refused = await h.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: `Bearer ${SERVICE_TOKEN}`, "x-archivist-user": OWNER.userId },
  });
  assert.equal(refused.statusCode, 401);
  const browser = await h.inject({
    method: "GET",
    url: "/api/me",
    cookies: { archivist_session: h.cookie(OWNER) },
  });
  assert.equal(browser.statusCode, 200);
  assert.equal(browser.json().isOwner, true);
});

test("owner status follows the owner list on every request, even for existing sessions", async (t) => {
  const h = await serviceHarness(t);
  const cookie = h.cookie({ userId: MEMBER.userId, isOwner: true });
  const me = await h.inject({
    method: "GET",
    url: "/api/me",
    cookies: { archivist_session: cookie },
  });
  // The session was created claiming ownership, but MEMBER is not in the list and is on no
  // whitelist, so the very next request ends it.
  assert.equal(me.statusCode, 403);
  assert.equal(me.json().details.reason, "not_admitted");
});
