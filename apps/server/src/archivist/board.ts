import type Database from "better-sqlite3";
import type { Actor, ArchivistContext } from "./context.js";
import type { RecordRef } from "./edit-log.js";
import { ArchivistError } from "./errors.js";
import { newId, optionalText, requiredText, TEXT_LIMITS, timestamp } from "./fields.js";
import { commitMutation, type DuringApply, type Expectation } from "./mutations.js";
import { resolveShortId } from "./lookup.js";
import { logEntry, notFoundRecord, openForActor } from "./records.js";
import { expectedVersionValue, staleVersion } from "./versions.js";

/**
 * The research board's gap cards. It is a backlog of what is missing, with
 * no assignees. The board keeps only what is still missing, in Needed and
 * Unrecoverable. Nothing records what was found or done: a card that is
 * finished is deleted, along with its own log lines.
 *
 * Derived cards follow the data: they open when a gap appears and are
 * deleted when it is filled, with one card per record, kind, and field. A
 * gap that returns gets a new card. They are kept in step inside the same
 * transaction as the change that caused them, so they never disagree with
 * the data. Contributors may change a derived card's priority and notes and
 * move it to Unrecoverable with a reason, but cannot clear one by hand, so a
 * card never claims media or evidence that does not exist.
 *
 * Manual cards are a date-research flag on an artifact, which needs a reason,
 * and low-priority custom research on any record. Contributors edit them,
 * move them between Needed and Unrecoverable, and delete them when done.
 */

/** Who created cards that no contributor's edit caused, such as on first opening an archive. */
export const SYSTEM_EDITOR = "archivist";

export type GapKind =
  | "unreadable_media"
  | "missing_characters"
  | "account_character"
  | "undated"
  | "missing_evidence"
  | "date_research"
  | "custom";
export type GapStatus = "needed" | "unrecoverable";
export type Priority = "critical" | "high" | "medium" | "low";
export type SubjectKind = "artifact" | "account" | "event" | "character" | "server";

const SUBJECT_COLUMNS: Record<SubjectKind, string> = {
  artifact: "artifact_id",
  account: "account_id",
  event: "event_id",
  character: "character_id",
  server: "server_id",
};
const SUBJECT_TABLES: Record<
  SubjectKind,
  "artifacts" | "accounts" | "events" | "characters" | "servers"
> = {
  artifact: "artifacts",
  account: "accounts",
  event: "events",
  character: "characters",
  server: "servers",
};

interface Derived {
  kind: GapKind;
  priority: Priority;
  subject: SubjectKind;
  /** The IDs of records that currently have this gap. */
  sql: string;
}

const DERIVED: Derived[] = [
  {
    kind: "unreadable_media",
    priority: "critical",
    subject: "artifact",
    sql: `SELECT a.id FROM artifacts a JOIN media m ON m.id = a.media_id
          WHERE json_extract(m.metadata_json, '$.readable') = 0`,
  },
  {
    kind: "missing_characters",
    priority: "high",
    subject: "artifact",
    sql: "SELECT id FROM artifacts WHERE unidentified_characters = 1",
  },
  {
    kind: "account_character",
    priority: "high",
    subject: "account",
    sql: "SELECT id FROM accounts WHERE kind = 'human' AND character_id IS NULL",
  },
  {
    kind: "undated",
    priority: "medium",
    subject: "artifact",
    sql: "SELECT id FROM artifacts WHERE selected_date_id IS NULL",
  },
  {
    kind: "missing_evidence",
    priority: "medium",
    subject: "event",
    sql: `SELECT e.id FROM events e
          WHERE NOT EXISTS (SELECT 1 FROM artifact_events ae WHERE ae.event_id = e.id)`,
  },
];
const DERIVED_KINDS = new Set(DERIVED.map((derived) => derived.kind));

/**
 * Brings derived cards in line with the data: deletes the cards whose gap is
 * filled and opens a card for each new gap. Runs inside a mutation's
 * transaction, which also removes the deleted cards' log lines. These
 * changes follow from the edit that caused them, so they add no log entries
 * of their own.
 */
export function syncGaps(
  db: Database.Database,
  now: string,
  actorId: string,
  during: DuringApply,
): void {
  for (const derived of DERIVED) {
    const column = SUBJECT_COLUMNS[derived.subject];
    const filled = db
      .prepare(
        `SELECT id FROM gap_cards WHERE kind = ? AND field_name = ''
           AND (status = 'resolved' OR ${column} NOT IN (${derived.sql}))`,
      )
      .all(derived.kind) as { id: string }[];
    const remove = db.prepare("DELETE FROM gap_cards WHERE id = ?");
    for (const { id } of filled) remove.run(id);
    during.removeRecords(filled.map(({ id }) => ({ record: "gap", id })));
    const missing = db
      .prepare(
        `SELECT d.id FROM (${derived.sql}) d WHERE NOT EXISTS (
           SELECT 1 FROM gap_cards g WHERE g.kind = ? AND g.${column} = d.id AND g.field_name = '')`,
      )
      .all(derived.kind) as { id: string }[];
    const insert = db.prepare(
      `INSERT INTO gap_cards (id, created_at, created_by, updated_at, kind, ${column}, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const { id } of missing)
      insert.run(newId(), now, actorId, now, derived.kind, id, derived.priority);
  }
}

/**
 * What opening an archive deletes before anyone reads it: derived cards
 * whose gap was filled elsewhere, and the requests and cards that earlier
 * versions kept in a Resolved bucket.
 */
export function staleBoardRecords(db: Database.Database): RecordRef[] {
  const requests = db
    .prepare("SELECT id FROM research_requests WHERE status = 'resolved'")
    .all() as { id: string }[];
  const cards = db.prepare("SELECT id FROM gap_cards WHERE status = 'resolved'").all() as {
    id: string;
  }[];
  for (const derived of DERIVED) {
    const column = SUBJECT_COLUMNS[derived.subject];
    cards.push(
      ...(db
        .prepare(
          `SELECT id FROM gap_cards WHERE kind = ? AND field_name = '' AND status <> 'resolved'
             AND ${column} NOT IN (${derived.sql})`,
        )
        .all(derived.kind) as { id: string }[]),
    );
  }
  return [
    ...requests.map(({ id }) => ({ record: "request", id })),
    ...cards.map(({ id }) => ({ record: "gap", id })),
  ];
}

/** The state a stale record has once `clearStaleBoard` has committed. */
export function staleExpectation(record: RecordRef): Expectation {
  return {
    table: record.record === "request" ? "research_requests" : "gap_cards",
    id: record.id,
    state: "absent",
  };
}

/**
 * Deletes what `staleBoardRecords` lists and opens cards for new gaps. Runs
 * inside the mutation that removes those records' log lines.
 */
export function clearStaleBoard(
  db: Database.Database,
  now: string,
  actorId: string,
  during: DuringApply,
): void {
  db.prepare("DELETE FROM research_requests WHERE status = 'resolved'").run();
  db.prepare("DELETE FROM gap_cards WHERE status = 'resolved'").run();
  syncGaps(db, now, actorId, during);
}

/** The gap cards that go with a record when it is deleted, so their log lines can go too. */
export function cardsOf(db: Database.Database, subject: SubjectKind, id: string): string[] {
  return (
    db.prepare(`SELECT id FROM gap_cards WHERE ${SUBJECT_COLUMNS[subject]} = ?`).all(id) as {
      id: string;
    }[]
  ).map((card) => card.id);
}

export interface GapCard {
  id: string;
  version: number;
  kind: GapKind;
  status: GapStatus;
  priority: Priority;
  subject: { kind: SubjectKind; id: string; label: string };
  field: string;
  reason: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  /** Derived cards follow the data and cannot be resolved by hand. */
  derived: boolean;
}

interface CardRow {
  id: string;
  version: number;
  kind: GapKind;
  status: GapStatus;
  priority: Priority;
  artifact_id: string | null;
  account_id: string | null;
  event_id: string | null;
  character_id: string | null;
  server_id: string | null;
  field_name: string;
  reason: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
}

function subjectLabel(db: Database.Database, kind: SubjectKind, id: string): string {
  const column = {
    artifact: "description",
    account: "label",
    event: "title",
    character: "known_name",
    server: "label",
  }[kind];
  const row = db
    .prepare(`SELECT ${column} AS label FROM ${SUBJECT_TABLES[kind]} WHERE id = ?`)
    .get(id) as { label: string } | undefined;
  return row?.label ?? id;
}

function toCard(db: Database.Database, row: CardRow): GapCard {
  const kind = (Object.keys(SUBJECT_COLUMNS) as SubjectKind[]).find(
    (subject) => row[SUBJECT_COLUMNS[subject] as keyof CardRow] !== null,
  )!;
  const id = row[SUBJECT_COLUMNS[kind] as keyof CardRow] as string;
  return {
    id: row.id,
    version: row.version,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    subject: { kind, id, label: subjectLabel(db, kind, id) },
    field: row.field_name,
    reason: row.reason,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    derived: DERIVED_KINDS.has(row.kind),
  };
}

const PRIORITY_ORDER =
  "CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";

/** Gap cards, highest priority first, then oldest, with optional status and kind filters. */
export function listGapCards(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; status?: GapStatus; kinds?: GapKind[] },
): GapCard[] {
  const { store } = openForActor(context, actor, input.archiveId);
  const rows = store.db
    .prepare(
      `SELECT * FROM gap_cards WHERE (@status IS NULL OR status = @status)
       ORDER BY ${PRIORITY_ORDER}, created_at, id`,
    )
    .all({ status: input.status ?? null }) as CardRow[];
  return rows
    .filter((row) => !input.kinds || input.kinds.includes(row.kind))
    .map((row) => toCard(store.db, row));
}

function subjectKindValue(value: unknown): SubjectKind {
  if (typeof value === "string" && value in SUBJECT_COLUMNS) return value as SubjectKind;
  throw new ArchivistError(
    "invalid_input",
    "The record must be an artifact, account, event, character, or server.",
    {
      field: "subjectKind",
    },
  );
}

/**
 * Flags a record for research: a date-research flag on an artifact, or a
 * custom low-priority card on any record. Each record, kind, and field has
 * one card.
 */
export function flagForResearch(
  context: ArchivistContext,
  actor: Actor,
  input: {
    archiveId: unknown;
    kind: unknown;
    /** Date-research flags are always on an artifact. */
    subjectKind?: unknown;
    subjectId: unknown;
    reason: unknown;
    field?: unknown;
  },
): GapCard {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  if (input.kind !== "date_research" && input.kind !== "custom") {
    throw new ArchivistError("invalid_input", "Flag kind must be date_research or custom.", {
      field: "kind",
    });
  }
  const kind = input.kind;
  const subjectKind = kind === "date_research" ? "artifact" : subjectKindValue(input.subjectKind);
  if (
    kind === "date_research" &&
    input.subjectKind !== undefined &&
    input.subjectKind !== "artifact"
  ) {
    throw new ArchivistError("invalid_input", "Only artifacts are flagged for date research.", {
      field: "subjectKind",
    });
  }
  const subjectId = resolveShortId(db, SUBJECT_TABLES[subjectKind], input.subjectId, subjectKind);
  const reason = requiredText("reason", input.reason, TEXT_LIMITS.reason);
  const field =
    kind === "date_research"
      ? "date"
      : (optionalText("field", input.field, TEXT_LIMITS.name) ?? "");
  const column = SUBJECT_COLUMNS[subjectKind];
  const existing = db
    .prepare(`SELECT * FROM gap_cards WHERE kind = ? AND ${column} = ? AND field_name = ?`)
    .get(kind, subjectId, field) as CardRow | undefined;
  if (existing) {
    throw new ArchivistError("invalid_input", "That is already on the board.", {
      field: "kind",
      cardId: existing.id,
    });
  }
  const now = timestamp(context.now());
  const id = newId();
  commitMutation(store, {
    expectations: [{ table: "gap_cards", id, state: "present" }],
    apply(target) {
      target
        .prepare(
          `INSERT INTO gap_cards (id, created_at, created_by, updated_at, kind, ${column}, field_name, priority, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          now,
          actor.userId,
          now,
          kind,
          subjectId,
          field,
          kind === "custom" ? "low" : "medium",
          reason,
        );
    },
    append: [
      logEntry(context, actor, "gap", id, {
        status: { old: null, new: "needed" },
        reason: { old: null, new: reason },
        kind: { old: null, new: kind },
        subject: { old: null, new: `${subjectKind} ${subjectId}` },
      }),
    ],
  });
  return toCard(db, db.prepare("SELECT * FROM gap_cards WHERE id = ?").get(id) as CardRow);
}

export function priorityValue(value: unknown): Priority {
  if (value === "critical" || value === "high" || value === "medium" || value === "low")
    return value;
  throw new ArchivistError("invalid_input", "Priority must be critical, high, medium, or low.", {
    field: "priority",
  });
}

function readCard(db: Database.Database, id: string): CardRow {
  const row = db.prepare("SELECT * FROM gap_cards WHERE id = ?").get(id) as CardRow | undefined;
  if (!row) throw notFoundRecord("card");
  return row;
}

/**
 * Edits a card's priority and reason, or moves it between Needed and
 * Unrecoverable. A derived card's reason is a contributor's note, and a
 * manual card's says what to research, so a manual card keeps one.
 * Unrecoverable needs a reason. A finished card is deleted with
 * `deleteGapCard` instead.
 */
export function updateGapCard(
  context: ArchivistContext,
  actor: Actor,
  input: {
    archiveId: unknown;
    id: unknown;
    expectedVersion: unknown;
    status?: unknown;
    priority?: unknown;
    reason?: unknown;
  },
): GapCard {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const id = resolveShortId(db, "gap_cards", input.id, "card");
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const row = readCard(db, id);
  if (input.status === "resolved") {
    throw new ArchivistError(
      "invalid_input",
      DERIVED_KINDS.has(row.kind)
        ? "This card clears by itself when the missing information is added."
        : "A finished card is deleted rather than kept. Delete it instead.",
      { field: "status" },
    );
  }
  if (input.status !== undefined && input.status !== "needed" && input.status !== "unrecoverable") {
    throw new ArchivistError("invalid_input", "Status must be needed or unrecoverable.", {
      field: "status",
    });
  }
  const status = (input.status ?? row.status) as GapStatus;
  const priority = input.priority === undefined ? row.priority : priorityValue(input.priority);
  const reason =
    input.reason === undefined
      ? row.reason
      : optionalText("reason", input.reason, TEXT_LIMITS.reason);
  if (status === "unrecoverable" && !reason) {
    throw new ArchivistError("invalid_input", "Say why it can't be found.", { field: "reason" });
  }
  if (!DERIVED_KINDS.has(row.kind) && !reason) {
    throw new ArchivistError("invalid_input", "Say what needs research.", { field: "reason" });
  }
  if (row.version !== expectedVersion) {
    throw staleVersion("card", id, row.version, {
      status: row.status,
      priority: row.priority,
      reason: row.reason,
    });
  }
  const card = toCard(db, row);
  if (status === row.status && priority === row.priority && reason === row.reason) return card;
  const now = timestamp(context.now());
  commitMutation(store, {
    expectations: [{ table: "gap_cards", id, version: row.version + 1 }],
    apply(target) {
      target
        .prepare(
          "UPDATE gap_cards SET status = ?, priority = ?, reason = ?, version = version + 1, updated_at = ? WHERE id = ?",
        )
        .run(status, priority, reason, now, id);
    },
    append: [
      logEntry(context, actor, "gap", id, {
        ...(status !== row.status ? { status: { old: row.status, new: status } } : {}),
        ...(priority !== row.priority ? { priority: { old: row.priority, new: priority } } : {}),
        ...(reason !== row.reason ? { reason: { old: row.reason, new: reason } } : {}),
      }),
    ],
  });
  return toCard(db, readCard(db, id));
}

/**
 * Deletes a finished manual card and its own log lines. Derived cards are
 * deleted when their gap is filled, so they cannot be deleted by hand.
 */
export function deleteGapCard(
  context: ArchivistContext,
  actor: Actor,
  input: { archiveId: unknown; id: unknown; expectedVersion: unknown },
): void {
  const { store } = openForActor(context, actor, input.archiveId);
  const db = store.db;
  const id = resolveShortId(db, "gap_cards", input.id, "card");
  const expectedVersion = expectedVersionValue(input.expectedVersion);
  const row = readCard(db, id);
  if (DERIVED_KINDS.has(row.kind)) {
    throw new ArchivistError(
      "invalid_input",
      "This card clears by itself when the missing information is added.",
      { field: "id" },
    );
  }
  if (row.version !== expectedVersion) throw staleVersion("card", id, row.version, {});
  commitMutation(store, {
    expectations: [{ table: "gap_cards", id, state: "absent" }],
    apply(target) {
      target.prepare("DELETE FROM gap_cards WHERE id = ?").run(id);
    },
    removeRecords: [{ record: "gap", id }],
  });
}
