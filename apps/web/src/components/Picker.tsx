import { useEffect, useState } from "react";
import { api, query } from "../api.js";
import { useSettled } from "../Shell.js";
import { useArchive } from "../state.js";
import { Avatar } from "../ui.js";
import { DateField } from "./DateField.js";
import { createEvent, createNamed } from "./quick-create.js";
import { useCharacters } from "./use-names.js";

export interface Picked {
  id: string;
  label: string;
}

type Kind = "character" | "event" | "account" | "server" | "channel";

/** Kinds a typed name can create, and what they are called in the list. */
const CREATABLE: Partial<Record<Kind, string>> = {
  character: "character",
  server: "server",
  event: "event",
};

const fold = (text: string) => text.normalize("NFKC").toLocaleLowerCase().trim();

/**
 * Finds a picker in `root` that still holds typed text nobody picked, and
 * focuses it. Forms call this before saving, because that text would
 * otherwise be dropped without a word. Returns the picker's label.
 */
export function unfinishedPicker(root: ParentNode | null): string | null {
  const input = root?.querySelector<HTMLInputElement>(".picker input[data-unfinished]");
  if (!input) return null;
  input.focus();
  return input.getAttribute("aria-label");
}

/** The error a form shows when `unfinishedPicker` finds one. */
export function unfinishedError(label: string): Error {
  return new Error(
    `${label} still has typed text that was not added. Press Enter or choose a match to add it, or clear it.`,
  );
}

async function search(archiveId: string, kind: Kind, typed: string, signal?: AbortSignal) {
  const path =
    kind === "event"
      ? `/api/archives/${archiveId}/events${query({ q: typed, limit: 8 })}`
      : `/api/archives/${archiveId}/entities/${kind}${query({ q: typed, limit: 8 })}`;
  const data = await api<{
    items: { id: string; label?: string; title?: string; detail?: string }[];
  }>(path, { signal });
  return data.items.map((item) => ({
    id: item.id,
    label: item.label ?? item.title ?? item.id,
    detail: item.detail,
  }));
}

/**
 * Chooses characters, events, or other records by typing their names. Chosen
 * ones show as removable chips. With `allowCreate`, several names can be
 * typed separated by commas: each one picks the record with exactly that
 * name, or creates a new one to fill in later. An event also needs the day
 * it happened, so a new event asks for it first.
 */
export function Picker(props: {
  archiveId: string;
  kind: Kind;
  label: string;
  value: Picked[];
  onChange(value: Picked[]): void;
  placeholder?: string;
  allowCreate?: boolean;
}) {
  const { changed, toast, revision } = useArchive();
  const characters = useCharacters(props.archiveId, revision);
  const [text, setText] = useState("");
  const [hits, setHits] = useState<(Picked & { detail?: string })[]>([]);
  const [busy, setBusy] = useState(false);
  const [newEvent, setNewEvent] = useState<{ title: string; day: string } | null>(null);
  const typed = useSettled(text.trim(), 180);
  const creatable = props.allowCreate && CREATABLE[props.kind];
  useEffect(() => {
    if (!typed) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    search(props.archiveId, props.kind, typed, controller.signal)
      .then(setHits)
      .catch(() => undefined);
    return () => controller.abort();
  }, [typed, props.kind, props.archiveId]);
  const chosen = new Set(props.value.map((item) => item.id));

  const add = (items: Picked[]) => {
    const fresh = items.filter((item, i) => !chosen.has(item.id) && items.indexOf(item) === i);
    if (fresh.length) props.onChange([...props.value, ...fresh]);
  };

  /** Picks the record named exactly `name`, or creates one when allowed. Events wait for a day. */
  const resolve = async (
    name: string,
  ): Promise<{ item: Picked; created: boolean } | "needs-day" | null> => {
    const matches = await search(props.archiveId, props.kind, name);
    const exact = matches.find((match) => fold(match.label) === fold(name));
    if (exact) return { item: exact, created: false };
    if (!creatable) return null;
    if (props.kind === "event") return "needs-day";
    const item = await createNamed(props.archiveId, props.kind as "character" | "server", name);
    return { item, created: true };
  };

  /** Handles every complete name in `value` before its last comma, or all of them on Enter. */
  const commit = async (value: string, all: boolean) => {
    const parts = value.split(",");
    const rest = all ? "" : parts.pop()!;
    const names = parts.map((part) => part.trim()).filter(Boolean);
    if (!names.length) return;
    setBusy(true);
    const picked: Picked[] = [];
    const left: string[] = [];
    let created = 0;
    try {
      for (const name of names) {
        const result = await resolve(name);
        if (result === "needs-day") {
          setNewEvent({ title: name, day: "" });
          left.push(name);
        } else if (result) {
          picked.push(result.item);
          if (result.created) created++;
        } else left.push(name);
      }
      add(picked);
      setText([...left, rest.trim()].filter(Boolean).join(", "));
      if (created) {
        changed();
        toast(
          `Added ${created} new ${CREATABLE[props.kind]}${created > 1 ? "s" : ""} to fill in later. The board lists ${created > 1 ? "them" : "it"}.`,
        );
      }
    } catch (failure) {
      toast(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const createOne = async (name: string) => {
    if (props.kind === "event") {
      setNewEvent({ title: name, day: "" });
      return;
    }
    setBusy(true);
    try {
      const created = await createNamed(
        props.archiveId,
        props.kind as "character" | "server",
        name,
      );
      add([created]);
      setText("");
      setHits([]);
      changed();
      toast(`Added ${name.trim()} to fill in later. The board lists it.`);
    } catch (failure) {
      toast(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const exactHit = hits.some((hit) => fold(hit.label) === fold(text));
  const offerCreate = creatable && text.trim() && !text.includes(",") && !exactHit;
  return (
    <div className="field picker">
      <span>{props.label}</span>
      {props.value.length ? (
        <div className="chips">
          {props.value.map((item) => (
            <span key={item.id} className={props.kind === "character" ? "chip person" : "chip"}>
              {props.kind === "character" ? (
                <Avatar
                  archiveId={props.archiveId}
                  picture={characters[item.id]?.picture ?? null}
                  name={item.label}
                  size="xs"
                />
              ) : null}
              {item.label}
              <button
                type="button"
                aria-label={`Remove ${item.label}`}
                onClick={() => props.onChange(props.value.filter((other) => other.id !== item.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <input
        value={text}
        disabled={busy}
        placeholder={
          props.placeholder ??
          (creatable ? "Type names, separated by commas" : "Start typing a name")
        }
        aria-label={props.label}
        data-unfinished={text.trim() ? "" : undefined}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          // Each finished name is handled as soon as its comma is typed.
          if (creatable && value.includes(",")) void commit(value, false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && creatable && text.trim()) {
            event.preventDefault();
            void commit(text, true);
          }
        }}
      />
      {creatable ? (
        <span className="hint">
          A name that is not in the archive yet becomes a new {CREATABLE[props.kind]} to fill in
          later.
        </span>
      ) : null}
      {newEvent ? (
        <div className="new-event">
          <span>
            New event <strong>{newEvent.title}</strong>. Every event needs the day it happened.
          </span>
          <DateField
            archiveId={props.archiveId}
            label="Day (an estimate is fine)"
            value={newEvent.day}
            onChange={(day) => setNewEvent({ ...newEvent, day })}
            placeholder="Jun 14 2020"
          />
          <div className="chips">
            <button
              className="btn"
              type="button"
              disabled={!newEvent.day.trim() || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const created = await createEvent(
                    props.archiveId,
                    newEvent.title,
                    newEvent.day.trim(),
                  );
                  add([created]);
                  setText((current) =>
                    current
                      .split(",")
                      .map((part) => part.trim())
                      .filter((part) => part && fold(part) !== fold(newEvent.title))
                      .join(", "),
                  );
                  setNewEvent(null);
                  changed();
                  toast(`Added the event ${created.label}. The board lists it to fill in later.`);
                } catch (failure) {
                  toast(failure instanceof Error ? failure.message : String(failure));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Add the event
            </button>
            <button className="btn ghost" type="button" onClick={() => setNewEvent(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {hits.length || offerCreate ? (
        <div className="picker-hits">
          {hits
            .filter((hit) => !chosen.has(hit.id))
            .map((hit) => (
              <button
                key={hit.id}
                type="button"
                onClick={() => {
                  add([hit]);
                  setText("");
                  setHits([]);
                }}
              >
                {hit.label}{" "}
                <small>
                  {hit.detail ? `${hit.detail} · ` : ""}
                  {hit.id.slice(0, 8)}
                </small>
              </button>
            ))}
          {offerCreate ? (
            <button type="button" className="create" onClick={() => void createOne(text)}>
              + New {CREATABLE[props.kind]} “{text.trim()}”
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
