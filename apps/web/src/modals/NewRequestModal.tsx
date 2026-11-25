import { useRef, useState } from "react";
import { api, type RequestDetails } from "../api.js";
import { DateField } from "../components/DateField.js";
import { type Picked, Picker, unfinishedError, unfinishedPicker } from "../components/Picker.js";
import { useWindows } from "../Shell.js";
import { useArchive } from "../state.js";
import { ErrorNote, Modal } from "../ui.js";

/**
 * A new missing-media request: what is missing, who is involved, and one
 * constraint on when it is from. New requests start in Needed.
 */

type ConstraintKind = RequestDetails["constraint"]["kind"];

const CONSTRAINTS: [ConstraintKind, string, string][] = [
  ["approximate_day", "Around a day", "One calendar day."],
  ["date_range", "Somewhere in a range", "Start and end days, both included."],
  ["before_date", "Before a date", "Strictly earlier than that day."],
  ["before_event", "Before an event", "Follows the event if its date is corrected."],
  ["after_event", "After an event", "After it ends, or after its day for one-day events."],
];

export function NewRequestModal(props: { characters?: Picked[] } = {}) {
  const { archive, changed, toast } = useArchive();
  const windows = useWindows();
  const [description, setDescription] = useState("");
  const [characters, setCharacters] = useState<Picked[]>(props.characters ?? []);
  const [kind, setKind] = useState<ConstraintKind>("approximate_day");
  const [day, setDay] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [anchor, setAnchor] = useState<Picked[]>([]);
  const [events, setEvents] = useState<Picked[]>([]);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLFormElement>(null);

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

  const submit = async () => {
    const left = unfinishedPicker(body.current);
    if (left) {
      setError(unfinishedError(left));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/archives/${archive.archiveId}/requests`, {
        method: "POST",
        json: {
          description,
          characters: characters.map((c) => c.id),
          constraint,
          events: events.map((e) => e.id),
          researchNotes: notes.trim() || undefined,
        },
      });
      changed();
      toast("Added to Needed.");
      windows.close();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New missing-media request"
      wide
      onClose={windows.close}
      footer={
        <>
          <button className="btn ghost" type="button" onClick={windows.close}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!complete || busy}
            onClick={submit}
          >
            Add request
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
        <label className="field">
          <span>Research notes (optional)</span>
          <input value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <ErrorNote error={error} />
      </form>
    </Modal>
  );
}
