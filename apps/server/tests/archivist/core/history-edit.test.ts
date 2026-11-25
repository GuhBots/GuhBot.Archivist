import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createArchive } from "../../../src/archivist/archives.js";
import type { ArchivistContext } from "../../../src/archivist/context.js";
import { parseLog } from "../../../src/archivist/edit-log.js";
import { createAccount, createCharacter, createServer } from "../../../src/archivist/entities.js";
import {
  type CharacterView,
  entityView,
  listCharacters,
  listPlaces,
} from "../../../src/archivist/entity-views.js";
import { ArchivistError, type ErrorCode } from "../../../src/archivist/errors.js";
import {
  addHistory,
  characterPictureAt,
  setPicture,
  updateHistory,
} from "../../../src/archivist/history.js";
import { createStagingFolder, stageMedia } from "../../../src/archivist/media.js";
import { addMember } from "../../../src/archivist/members.js";
import { closeMetadataReader } from "../../../src/archivist/metadata.js";
import { makeArchivist, MEMBER, OWNER } from "../helpers/context.js";
import { closeFixtureWriter, writeImage } from "../helpers/media.js";

after(async () => {
  await closeMetadataReader();
  await closeFixtureWriter();
});

function setup(t: TestContext) {
  const { context } = makeArchivist(t);
  const { archiveId } = createArchive(context, OWNER, { name: "Edits" });
  addMember(context, OWNER, { archiveId, userId: MEMBER.userId });
  const db = context.stores.get(archiveId)!.db;
  const log = () =>
    parseLog(readFileSync(join(context.paths.archivesRoot, archiveId, "edits.log"), "utf8"));
  const version = (table: string, id: string) =>
    (db.prepare(`SELECT version FROM ${table} WHERE id = ?`).get(id) as { version: number })
      .version;
  return { context, archiveId, db, log, version };
}

function fails(code: ErrorCode) {
  return (error: unknown) => error instanceof ArchivistError && error.code === code;
}

async function image(context: ArchivistContext) {
  const file = join(createStagingFolder(context), "original");
  await writeImage(file, "png");
  return stageMedia(context, { file, originalFilename: "avatar.png" });
}

test("an entry's unknown date can be filled in later, with the parent's version and one log entry", (t) => {
  const { context, archiveId, log, version } = setup(t);
  const sam = createCharacter(context, MEMBER, { archiveId, knownName: "Sam" });
  const alias = addHistory(context, MEMBER, {
    archiveId,
    kind: "alias",
    parentId: sam.id,
    expectedVersion: 1,
    name: "Sammy",
  });
  assert.equal(alias.date, null);

  const dated = updateHistory(context, MEMBER, {
    archiveId,
    kind: "alias",
    parentId: sam.id,
    entryId: alias.id,
    expectedVersion: 2,
    date: "Sep 1 2019",
  });
  assert.equal(dated.id, alias.id);
  assert.equal(dated.name, "Sammy");
  assert.equal(dated.date?.archiveDay, "2019-09-01");
  assert.equal(version("characters", sam.id), 3);
  assert.deepEqual(log().at(-1)?.changes, {
    alias: { old: { name: "Sammy" }, new: { name: "Sammy", date: "Sep 1 2019" } },
  });

  // Renaming and clearing the date again are edits too.
  const renamed = updateHistory(context, MEMBER, {
    archiveId,
    kind: "alias",
    parentId: sam.id,
    entryId: alias.id,
    expectedVersion: 3,
    name: "Sammie",
    date: null,
  });
  assert.equal(renamed.name, "Sammie");
  assert.equal(renamed.date, null);

  // Saving the same values changes nothing.
  const lines = log().length;
  updateHistory(context, MEMBER, {
    archiveId,
    kind: "alias",
    parentId: sam.id,
    entryId: alias.id,
    expectedVersion: 4,
    name: "Sammie",
  });
  assert.equal(log().length, lines);
  assert.equal(version("characters", sam.id), 4);

  assert.throws(
    () =>
      updateHistory(context, MEMBER, {
        archiveId,
        kind: "alias",
        parentId: sam.id,
        entryId: alias.id,
        expectedVersion: 2,
        date: "2019-09-01",
      }),
    fails("stale_version"),
  );
  assert.throws(
    () =>
      updateHistory(context, MEMBER, {
        archiveId,
        kind: "alias",
        parentId: sam.id,
        entryId: "not-an-entry",
        expectedVersion: 4,
        date: "2019-09-01",
      }),
    fails("not_found"),
  );
});

test("main accounts, introductions, and memberships take edited dates with their own rules", (t) => {
  const { context, archiveId } = setup(t);
  const sam = createCharacter(context, MEMBER, { archiveId, knownName: "Sam" });
  const alex = createCharacter(context, MEMBER, { archiveId, knownName: "Alex" });
  const account = createAccount(context, MEMBER, {
    archiveId,
    kind: "human",
    label: "sam_main",
    characterId: sam.id,
  });
  const server = createServer(context, MEMBER, { archiveId, label: "Hangout" });

  const main = addHistory(context, MEMBER, {
    archiveId,
    kind: "main_account",
    parentId: sam.id,
    expectedVersion: 1,
    targetId: account.id,
  });
  const mainDated = updateHistory(context, MEMBER, {
    archiveId,
    kind: "main_account",
    parentId: sam.id,
    entryId: main.id,
    expectedVersion: 2,
    date: "2019-08-01",
  });
  assert.equal(mainDated.targetId, account.id);
  assert.equal(mainDated.date?.archiveDay, "2019-08-01");

  // An introduction belongs to the introduced character, so its version is the one checked.
  const intro = addHistory(context, MEMBER, {
    archiveId,
    kind: "introduction",
    parentId: alex.id,
    expectedVersion: 1,
    targetId: sam.id,
  });
  const samView = entityView(context, MEMBER, { archiveId, kind: "character", id: sam.id });
  assert.equal(samView.kind, "character");
  const introduced = (samView as CharacterView).introduced[0]!;
  assert.equal(introduced.entryId, intro.id);
  assert.equal(introduced.characterVersion, 2);
  updateHistory(context, MEMBER, {
    archiveId,
    kind: "introduction",
    parentId: introduced.characterId,
    entryId: introduced.entryId,
    expectedVersion: introduced.characterVersion,
    date: "Aug 3 2019",
  });
  const after = entityView(context, MEMBER, { archiveId, kind: "character", id: sam.id });
  assert.equal((after as CharacterView).introduced[0]!.date?.archiveDay, "2019-08-03");

  const membership = addHistory(context, MEMBER, {
    archiveId,
    kind: "membership",
    parentId: account.id,
    expectedVersion: 1,
    targetId: server.id,
    start: "2019-01-01",
  });
  assert.throws(
    () =>
      updateHistory(context, MEMBER, {
        archiveId,
        kind: "membership",
        parentId: account.id,
        entryId: membership.id,
        expectedVersion: 2,
        end: "2018-12-31",
      }),
    (error: unknown) =>
      fails("invalid_input")(error) && (error as ArchivistError).details.field === "end",
  );
  const left = updateHistory(context, MEMBER, {
    archiveId,
    kind: "membership",
    parentId: account.id,
    entryId: membership.id,
    expectedVersion: 2,
    end: "2020-06-30",
  });
  assert.equal(left.start?.archiveDay, "2019-01-01");
  assert.equal(left.end?.archiveDay, "2020-06-30");
});

test("an avatar on any linked account stands in for a character with no main account or fallback", async (t) => {
  const { context, archiveId, db } = setup(t);
  const sam = createCharacter(context, MEMBER, { archiveId, knownName: "Sam" });
  const account = createAccount(context, MEMBER, {
    archiveId,
    kind: "human",
    label: "sam_main",
    characterId: sam.id,
  });
  assert.deepEqual(characterPictureAt(db, sam.id), { source: "initials" });

  // An undated avatar, as the owner uploaded one: no main account is recorded.
  const avatar = addHistory(context, MEMBER, {
    archiveId,
    kind: "avatar",
    parentId: account.id,
    expectedVersion: 1,
    media: await image(context),
  });
  const standIn = {
    source: "avatar",
    accountId: account.id,
    mediaId: avatar.mediaId,
    standIn: true,
  };
  assert.deepEqual(characterPictureAt(db, sam.id), standIn);
  // The side columns ask for the timeline's day. The avatar still shows, marked as a stand-in.
  assert.deepEqual(characterPictureAt(db, sam.id, "2026-11-25"), standIn);
  const listed = listCharacters(context, MEMBER, { archiveId, day: "2026-11-25" }).items[0]!;
  assert.deepEqual(listed.picture, standIn);
  // With no main account recorded, the only account names them.
  assert.equal(listed.mainAccount, "sam_main");

  // Naming the main account, undated, makes its avatar their picture outside the timeline.
  addHistory(context, MEMBER, {
    archiveId,
    kind: "main_account",
    parentId: sam.id,
    expectedVersion: 1,
    targetId: account.id,
  });
  assert.deepEqual(characterPictureAt(db, sam.id), { ...standIn, standIn: false });
  assert.deepEqual(characterPictureAt(db, sam.id, "2026-11-25"), standIn);
  const page = entityView(context, MEMBER, { archiveId, kind: "character", id: sam.id });
  assert.deepEqual((page as CharacterView).picture, { ...standIn, standIn: false });

  // A fallback picture a contributor chose beats a stand-in, but not an avatar known for the day.
  setPicture(context, MEMBER, {
    archiveId,
    kind: "character",
    id: sam.id,
    expectedVersion: 2,
    media: await image(context),
  });
  assert.equal(characterPictureAt(db, sam.id, "2026-11-25").source, "fallback");
  assert.deepEqual(characterPictureAt(db, sam.id), { ...standIn, standIn: false });
});

test("the characters column names a character's main account, and records list what blocks deleting them", (t) => {
  const { context, archiveId } = setup(t);
  const sam = createCharacter(context, MEMBER, { archiveId, knownName: "Sam", realName: "Sam R" });
  const first = createAccount(context, MEMBER, {
    archiveId,
    kind: "human",
    label: "sam_old",
    characterId: sam.id,
  });
  const second = createAccount(context, MEMBER, {
    archiveId,
    kind: "human",
    label: "sam_new",
    characterId: sam.id,
  });
  const name = (day?: string) =>
    listCharacters(context, MEMBER, { archiveId, day }).items[0]!.mainAccount;
  // Two accounts and no main account recorded: nothing to guess from.
  assert.equal(name(), null);
  addHistory(context, MEMBER, {
    archiveId,
    kind: "main_account",
    parentId: sam.id,
    expectedVersion: 1,
    targetId: first.id,
    date: "2019-01-01",
  });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "main_account",
    parentId: sam.id,
    expectedVersion: 2,
    targetId: second.id,
    date: "2022-01-01",
  });
  addHistory(context, MEMBER, {
    archiveId,
    kind: "account_name",
    parentId: second.id,
    expectedVersion: 1,
    name: "sam.renamed",
    date: "2023-01-01",
  });
  assert.equal(name("2020-06-01"), "sam_old");
  assert.equal(name("2022-06-01"), "sam_new");
  assert.equal(name("2024-01-01"), "sam.renamed");
  // Before any main account, the latest one names them.
  assert.equal(name("2018-01-01"), "sam_new");

  const view = entityView(context, MEMBER, { archiveId, kind: "character", id: sam.id });
  assert.deepEqual(view.blockers, { accounts: 2 });
  const account = entityView(context, MEMBER, { archiveId, kind: "account", id: second.id });
  assert.deepEqual(account.blockers, { "main-account records": 1 });
  assert.equal(account.kind === "account" && account.name, "sam.renamed");
});

test("a server's latest icon stands in on days before any icon is known", async (t) => {
  const { context, archiveId } = setup(t);
  const server = createServer(context, MEMBER, { archiveId, label: "Hangout" });
  const icon = addHistory(context, MEMBER, {
    archiveId,
    kind: "server_icon",
    parentId: server.id,
    expectedVersion: 1,
    media: await image(context),
  });
  const place = (day: string) => listPlaces(context, MEMBER, { archiveId, day })[0]!;
  assert.equal(place("2026-11-25").iconMediaId, icon.mediaId);
  assert.equal(place("2026-11-25").iconStandIn, true);
  updateHistory(context, MEMBER, {
    archiveId,
    kind: "server_icon",
    parentId: server.id,
    entryId: icon.id,
    expectedVersion: 2,
    date: "2020-01-01",
  });
  assert.equal(place("2026-11-25").iconStandIn, false);
  assert.equal(place("2019-01-01").iconStandIn, true);
});
