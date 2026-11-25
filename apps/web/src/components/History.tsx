import { type ReactNode, useState } from "react";
import type { HistoryEntry } from "../api.js";
import { dayText } from "../format.js";
import { useArchive } from "../state.js";
import { DateField } from "./DateField.js";

/**
 * Dated history rows, such as aliases, account names, and memberships, with
 * a way to change each entry's name and dates later. The owner asked on
 * 2026-11-25 that everything recorded with a date can have that date filled
 * in or corrected afterward.
 */

/** New values for an entry. Undefined leaves a value alone, and null makes a date unknown. */
export interface HistoryChange {
  name?: string;
  date?: string | null;
  start?: string | null;
  end?: string | null;
}

/** Kinds whose entries carry a name of their own. */
const NAMED = new Set(["alias", "account_name", "server_name", "channel_name"]);
/** Kinds dated by a start and an end rather than one day. */
const SPANS = new Set(["membership", "ownership"]);

export const whenText = (entry: HistoryEntry) =>
  entry.date ? dayText(entry.date.archiveDay) : "date unknown";

export const spanText = (entry: HistoryEntry) =>
  `${entry.start ? dayText(entry.start.archiveDay) : "unknown start"} to ${
    entry.end ? dayText(entry.end.archiveDay) : "now or unknown"
  }`;

/** How many links of each kind block a deletion, as a sentence fragment such as `3 artifacts and 1 account`. */
export function blockersText(blockers: Record<string, number>): string {
  const parts = Object.entries(blockers).map(
    ([label, count]) => `${count} ${count === 1 ? label.replace(/s$/, "") : label}`,
  );
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts.join("");
}

/** History rows, oldest first with undated ones last. While editing, each can be changed or removed. */
export function HistoryRows(props: {
  entries: HistoryEntry[];
  editing: boolean;
  render(entry: HistoryEntry): ReactNode;
  onRemove(entry: HistoryEntry): void;
  /** Saves new values. Without it, entries can only be removed. */
  onEdit?(entry: HistoryEntry, change: HistoryChange): Promise<boolean>;
  dates?: (entry: HistoryEntry) => string;
  empty?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!props.entries.length) {
    return <span className="hint">{props.empty ?? "Nothing recorded."}</span>;
  }
  const day = (entry: HistoryEntry) =>
    entry.date?.archiveDay ?? entry.start?.archiveDay ?? "9999-12-31";
  const sorted = [...props.entries].sort((a, b) => day(a).localeCompare(day(b)));
  return (
    <div className="hist">
      {sorted.map((entry) => {
        const key = `${entry.kind}:${entry.id}`;
        if (open === key && props.onEdit) {
          return (
            <EntryEditor
              key={key}
              entry={entry}
              onCancel={() => setOpen(null)}
              onSave={async (change) => {
                if (await props.onEdit!(entry, change)) setOpen(null);
              }}
            />
          );
        }
        const editable = props.editing && props.onEdit && entry.kind !== "bot_owner";
        return (
          <div key={key}>
            <time>{props.dates ? props.dates(entry) : whenText(entry)}</time>
            <span>{props.render(entry)}</span>
            {props.editing ? (
              <span className="row-actions">
                {editable ? (
                  <button className="rm edit" type="button" onClick={() => setOpen(key)}>
                    Edit
                  </button>
                ) : null}
                <button className="rm" type="button" onClick={() => props.onRemove(entry)}>
                  Remove
                </button>
              </span>
            ) : (
              <span />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One entry's name and dates in place, with Save and Cancel. Empty dates become unknown. */
function EntryEditor(props: {
  entry: HistoryEntry;
  onSave(change: HistoryChange): Promise<void>;
  onCancel(): void;
}) {
  const { archive } = useArchive();
  const { entry } = props;
  const named = NAMED.has(entry.kind);
  const span = SPANS.has(entry.kind);
  const [name, setName] = useState(entry.name ?? "");
  const [date, setDate] = useState(entry.date?.originalText ?? "");
  const [start, setStart] = useState(entry.start?.originalText ?? "");
  const [end, setEnd] = useState(entry.end?.originalText ?? "");
  const [busy, setBusy] = useState(false);
  // Only what changed is sent, so a date that stays as typed is not read again.
  const changed = (value: string, before: string | undefined) =>
    value.trim() === (before ?? "") ? undefined : value.trim() || null;
  const change: HistoryChange = {
    ...(named && name.trim() !== (entry.name ?? "") ? { name: name.trim() } : {}),
    ...(span
      ? {
          start: changed(start, entry.start?.originalText),
          end: changed(end, entry.end?.originalText),
        }
      : { date: changed(date, entry.date?.originalText) }),
  };
  const dirty = Object.values(change).some((value) => value !== undefined);
  return (
    <form
      className="addrow entry-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!dirty || (named && !name.trim())) return;
        setBusy(true);
        try {
          await props.onSave(change);
        } finally {
          setBusy(false);
        }
      }}
    >
      {named ? (
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
      ) : null}
      {span ? (
        <>
          <DateField
            archiveId={archive.archiveId}
            label="From (empty if unknown)"
            value={start}
            onChange={setStart}
            placeholder="Jul 15 2019"
          />
          <DateField
            archiveId={archive.archiveId}
            label="Until (empty if ongoing or unknown)"
            value={end}
            onChange={setEnd}
            placeholder="Mar 2 2021"
          />
        </>
      ) : (
        <DateField
          archiveId={archive.archiveId}
          label="Date (empty if unknown)"
          value={date}
          onChange={setDate}
          placeholder="Jul 15 2019"
        />
      )}
      <span className="row-actions">
        <button className="btn ghost" type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          className="btn primary"
          type="submit"
          disabled={busy || !dirty || (named && !name.trim())}
        >
          Save
        </button>
      </span>
    </form>
  );
}
