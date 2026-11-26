import { useEffect, useRef, useState } from "react";
import { api, ApiError, type EventDetails, type RequestDetails } from "../api.js";
import { DateField } from "../components/DateField.js";
import { type Picked, Picker, unfinishedError, unfinishedPicker } from "../components/Picker.js";
import { shortId } from "../format.js";
import { useWindows } from "../Shell.js";
import { useArchive } from "../state.js";
import { ErrorNote, Modal } from "../ui.js";

/**
 * A missing-media request's window: what is missing, who is involved, one
 * constraint on when it is from, related events, priority, and notes. It
 * adds a new request to Needed, or edits an existing one in either bucket.
 * An existing request can also be deleted here, such as once it is found.
 */

type ConstraintKind = RequestDetails["constraint"]["kind"];
type Priority = RequestDetails["priority"];

const CONSTRAINTS: [ConstraintKind, string, string][] = [
  ["approximate_day", "Around a day", "One calendar day."],
  ["date_range", "Somewhere in a range", "Start and end days, both included."],
  ["before_date", "Before a date", "Strictly earlier than that day."],
  ["before_event", "Before an event", "Follows the event if its date is corrected."],
  ["after_event", "After an event", "After it ends, or after its day for one-day events."],
];

export const PRIORITIES: [Priority, string][] = [
  ["critical", "Critical"],
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
];

/** The records an existing request links to, named for the pickers. */
interface Named {
  characters: Picked[];
  events: Picked[];
  anchor: Picked[];
}

export function RequestModal(props: { request?: RequestDetails; characters?: Picked[] }) {
  const { archive } = useArchive();
  const windows = useWindows();
  const { request } = props;
  const [named, setNamed] = useState<Named | null>(
    request ? null : { characters: props.characters ?? [], events: [], anchor: [] },
  );
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!request) return;
    const base = `/api/archives/${archive.archiveId}`;
    const characterName = (id: string) =>
      api<{ knownName: string }>(`${base}/entities/character/${id}`).then(
        (character) => ({ id, label: character.knownName }),
        () => ({ id, label: shortId(id) }),
      );
    const eventName = (id: string) =>
      api<EventDetails>(`${base}/events/${id}`).then(
        (event) => ({ id, label: event.title }),
        () => ({ id, label: shortId(id) }),
      );
    const anchorId = request.constraint.anchorEventId;
    Promise.all([
      Promise.all(request.characters.map(characterName)),
      Promise.all(request.events.map(eventName)),
      anchorId ? eventName(anchorId).then((event) => [event]) : Promise.resolve([]),
    ])
      .then(([characters, events, anchor]) => setNamed({ characters, events, anchor }))
      .catch(setError);
  }, [archive.archiveId, request]);

  if (!named) {
    return (
      <Modal title="Missing-media request" onClose={windows.close}>
        <div className="content">{error ? <ErrorNote error={error} /> : "Loading…"}</div>
      </Modal>
    );
  }
  return <RequestForm request={request} named={named} />;
}

function RequestForm(props: { request?: RequestDetails; named: Named }) {
  const { archive, changed, toast } = useArchive();
  const windows = useWindows();
  const { request, named } = props;
  const [description, setDescription] = useState(request?.description ?? "");
  const [characters, setCharacters] = useState<Picked[]>(named.characters);
  const [kind, setKind] = useState<ConstraintKind>(request?.constraint.kind ?? "approximate_day");
  const startDay = request?.constraint.startDay ?? "";
  const [day, setDay] = useState(kind === "date_range" ? "" : startDay);
  const [start, setStart] = useState(kind === "date_range" ? startDay : "");
  const [end, setEnd] = useState(request?.constraint.endDay ?? "");
  const [anchor, setAnchor] = useState<Picked[]>(named.anchor);
  const [events, setEvents] = useState<Picked[]>(named.events);
  const [priority, setPriority] = useState<Priority>(request?.priority ?? "medium");
  const [notes, setNotes] = useState(request?.researchNotes ?? "");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const body = useRef<HTMLFormElement>(null);
  const base = `/api/archives/${archive.archiveId}/requests`;

  const constraint =
    kind === "date_range"
      ? { kind, start, end }
      : kind === "before_event" || kind === "after_event"
        ? { kind, eventId: anchor[0]?.id }
        : { kind, day };
  const complete =
    description.trim() &&
    characters.length > 0 &&
    (kind === "date_range"
      ? start.trim() && end.trim()
      : kind === "before_event" || kind === "after_event"
        ? anchor.length === 1
        : day.trim());

  /** Runs a change. A stale version reloads the board and says so. */
  const attempt = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      changed();
      toast(done);
      windows.close();
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "stale_version") {
        changed();
        setError(
          new Error(
            "Someone else changed this request. Close this window to see its current state.",
          ),
        );
      } else setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const left = unfinishedPicker(body.current);
    if (left) {
      setError(unfinishedError(left));
      return;
    }
    if (!request) {
      return attempt(
        () =>
          api(base, {
            method: "POST",
            json: {
              description,
              characters: characters.map((c) => c.id),
              constraint,
              events: events.map((e) => e.id),
              priority,
              researchNotes: notes.trim() || undefined,
            },
          }),
        "Added to Needed.",
      );
    }
    const chosen = (list: Picked[]) => list.map((item) => item.id);
    const added = (before: string[], after: string[]) => after.filter((id) => !before.includes(id));
    return attempt(
      () =>
        api(`${base}/${request.id}`, {
          method: "PATCH",
          json: {
            expectedVersion: request.version,
            description,
            constraint,
            priority,
            researchNotes: notes.trim() || null,
            addCharacters: added(request.characters, chosen(characters)),
            removeCharacters: added(chosen(characters), request.characters),
            addEvents: added(request.events, chosen(events)),
            removeEvents: added(chosen(events), request.events),
          },
        }),
      "Saved the request.",
    );
  };

  if (request && confirmDelete) {
    return (
      <Modal
        title={`Delete ${request.label}?`}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <button className="btn ghost" type="button" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
            <button
              className="btn danger"
              type="button"
              disabled={busy}
              onClick={() =>
                attempt(
                  () =>
                    api(`${base}/${request.id}?expectedVersion=${request.version}`, {
                      method: "DELETE",
                    }),
                  "Deleted the request.",
                )
              }
            >
              Delete permanently
            </button>
          </>
        }
      >
        <div className="content">
          <p style={{ margin: 0 }}>
            The request and its edit history are removed, and nothing records that it was found.
          </p>
          <ErrorNote error={error} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={request ? "Edit missing-media request" : "New missing-media request"}
      wide
      onClose={windows.close}
      footer={
        <>
          {request ? (
            <button
              className="btn danger"
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </button>
          ) : null}
          <button className="btn ghost" type="button" onClick={windows.close}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!complete || busy}
            onClick={() => void submit()}
          >
            {request ? "Save" : "Add request"}
          </button>
        </>
      }
    >
      <form
        ref={body}
        className="content"
        onSubmit={(event) => {
          event.preventDefault();
          if (complete && !busy) void submit();
        }}
      >
        {request?.status === "unrecoverable" && request.unrecoverableReason ? (
          <p className="hint" style={{ margin: 0 }}>
            Can't be found: {request.unrecoverableReason}
          </p>
        ) : null}
        <label className="field">
          <span>What is missing</span>
          <textarea
            value={description}
            placeholder="Photos from the first meetup"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <Picker
          archiveId={archive.archiveId}
          kind="character"
          label="Characters involved (at least one)"
          value={characters}
          onChange={setCharacters}
          allowCreate
        />
        <div className="field">
          <span>When</span>
          <div className="radio-list" role="radiogroup" aria-label="When">
            {CONSTRAINTS.map(([value, label, hint]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="constraint"
                  checked={kind === value}
                  onChange={() => setKind(value)}
                />
                <span>
                  {label}
                  <small>{hint}</small>
                </span>
              </label>
            ))}
          </div>
        </div>
        {kind === "date_range" ? (
          <div className="grid2">
            <DateField
              archiveId={archive.archiveId}
              label="From"
              value={start}
              onChange={setStart}
              placeholder="Mar 1 2020"
            />
            <DateField
              archiveId={archive.archiveId}
              label="To"
              value={end}
              onChange={setEnd}
              placeholder="Mar 14 2020"
            />
          </div>
        ) : kind === "before_event" || kind === "after_event" ? (
          <Picker
            archiveId={archive.archiveId}
            kind="event"
            label="Event"
            value={anchor}
            onChange={(value) => setAnchor(value.slice(-1))}
          />
        ) : (
          <DateField
            archiveId={archive.archiveId}
            label="Day"
            value={day}
            onChange={setDay}
            placeholder="Dec 5 2020"
          />
        )}
        <Picker
          archiveId={archive.archiveId}
          kind="event"
          label="Related events (optional)"
          value={events}
          onChange={setEvents}
        />
        <div className="grid2">
          <label className="field">
            <span>Priority</span>
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value as Priority)}
            >
              {PRIORITIES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Research notes (optional)</span>
            <input value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
        </div>
        <ErrorNote error={error} />
      </form>
    </Modal>
  );
}
