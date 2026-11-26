import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type GapCard, type RequestDetails } from "../api.js";
import { ArtifactChooser, type ChosenArtifact } from "../components/ArtifactChooser.js";
import { TO_FILL_IN } from "../components/quick-create.js";
import { useCharacters } from "../components/use-names.js";
import { shortId } from "../format.js";
import { AccountModal } from "../modals/AccountModal.js";
import { PRIORITIES, RequestModal } from "../modals/RequestModal.js";
import { characterPath, navigate, placePath } from "../router.js";
import { useWindows } from "../Shell.js";
import { loadLocal, saveLocal, useArchive } from "../state.js";
import { Avatar, ErrorNote, Modal } from "../ui.js";
import { AddMenu } from "../components/AddMenu.js";
import { ViewFrame } from "./ViewFrame.js";

/**
 * The research board: what the archive is still missing, in Needed and
 * Unrecoverable. Nothing records what was found or done. A missing-media
 * request that is found is deleted, as is a research card once it is done,
 * and a gap card is deleted by itself when the information is added.
 * Selecting a card opens it for editing. Nobody is assigned anything.
 */

type Show = "all" | "requests" | "gaps";
type Status = RequestDetails["status"];

const BUCKETS: [Status, string][] = [
  ["needed", "Needed"],
  ["unrecoverable", "Unrecoverable"],
];

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

const GAP_LABELS: Record<GapCard["kind"], string> = {
  unreadable_media: "Unreadable media",
  missing_characters: "Unidentified characters",
  account_character: "Account without character",
  undated: "No date",
  missing_evidence: "Event without evidence",
  date_research: "Date research",
  custom: "Research note",
};

const GAP_TEXT: Partial<Record<GapCard["kind"], string>> = {
  unreadable_media: "The original file cannot be read. It is kept exactly as uploaded.",
  missing_characters: "Someone in this is not identified yet.",
  account_character: "This account is not linked to a character. Link it from a character's page.",
  undated: "No exact, estimated, or file date.",
  missing_evidence: "No supporting artifacts.",
};

const SUBJECT_NAMES: Record<GapCard["subject"]["kind"], string> = {
  artifact: "artifact",
  account: "account",
  event: "event",
  character: "character",
  server: "place",
};

type Item =
  | {
      type: "request";
      status: Status;
      priority: GapCard["priority"];
      at: string;
      request: RequestDetails;
    }
  | { type: "gap"; status: Status; priority: GapCard["priority"]; at: string; card: GapCard };

export function BoardView() {
  const { archive, revision, changed, toast } = useArchive();
  const windows = useWindows();
  const [show, setShow] = useState<Show>(() => loadLocal("archivist:board-show", "all"));
  const [requests, setRequests] = useState<RequestDetails[] | null>(null);
  const [cards, setCards] = useState<GapCard[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const base = `/api/archives/${archive.archiveId}`;

  useEffect(() => {
    Promise.all([
      api<{ items: RequestDetails[] }>(`${base}/requests`),
      api<{ items: GapCard[] }>(`${base}/backlog`),
    ])
      .then(([r, c]) => {
        setRequests(r.items);
        setCards(c.items);
        setError(null);
      })
      .catch(setError);
  }, [base, revision]);

  /** Runs a change, then reloads the board. A stale version reloads too and says why. */
  const run = useCallback(
    async (action: () => Promise<unknown>, done: string) => {
      try {
        await action();
        changed();
        toast(done);
        return true;
      } catch (failure) {
        if (failure instanceof ApiError && failure.code === "stale_version") {
          changed();
          toast("Someone else changed this card. The board now shows its current state.");
        } else toast(failure instanceof Error ? failure.message : String(failure));
        return false;
      }
    },
    [changed, toast],
  );

  const items: Item[] = [];
  if (show !== "gaps") {
    for (const request of requests ?? []) {
      items.push({
        type: "request",
        status: request.status,
        priority: request.priority,
        at: request.createdAt,
        request,
      });
    }
  }
  if (show !== "requests") {
    for (const card of cards ?? []) {
      items.push({
        type: "gap",
        status: card.status,
        priority: card.priority,
        at: card.createdAt,
        card,
      });
    }
  }
  items.sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.at.localeCompare(b.at),
  );

  const seg = (value: Show, label: string) => (
    <button
      key={value}
      className="btn"
      type="button"
      aria-pressed={show === value}
      onClick={() => {
        setShow(value);
        saveLocal("archivist:board-show", value);
      }}
    >
      {label}
    </button>
  );

  return (
    <ViewFrame
      label="Board"
      head={
        <>
          <h1>Research board</h1>
          <span className="meta">
            What the archive is still missing. Select a card to edit it. Gaps clear by themselves
            when the information is added, and a request is deleted once it is found. Nobody is
            assigned anything.
          </span>
        </>
      }
      tray={
        <>
          <AddMenu />
          <span className="sep" />
          <button className="btn" type="button" onClick={() => windows.show(<FlagDateModal />)}>
            Flag a date for research
          </button>
          <span className="sep" />
          <span className="label">Show</span>
          <div className="seg" role="group" aria-label="Show">
            {seg("all", "All")}
            {seg("requests", "Missing media")}
            {seg("gaps", "Gaps")}
          </div>
        </>
      }
    >
      <ErrorNote error={error} />
      {requests && cards ? (
        <div className="board">
          {BUCKETS.map(([status, title]) => {
            const list = items.filter((item) => item.status === status);
            return (
              <section key={status} className="bucket" aria-label={title}>
                <h2>
                  {title} <span>{list.length}</span>
                </h2>
                {list.map((item) =>
                  item.type === "request" ? (
                    <RequestCard key={item.request.id} request={item.request} run={run} />
                  ) : (
                    <GapCardView key={item.card.id} card={item.card} run={run} />
                  ),
                )}
                {list.length ? null : (
                  <p className="hint" style={{ margin: 4 }}>
                    Nothing here.
                  </p>
                )}
              </section>
            );
          })}
        </div>
      ) : error ? null : (
        <div className="empty">Loading the board…</div>
      )}
    </ViewFrame>
  );
}

type Run = (action: () => Promise<unknown>, done: string) => Promise<boolean>;

/**
 * Opens a card's window when the card itself is selected. Its own buttons,
 * such as a character chip, keep their action.
 */
function openUnlessControl(open: () => void) {
  return (event: React.MouseEvent) => {
    if ((event.target as Element).closest("button, a, input, select, textarea")) return;
    open();
  };
}

function RequestCard(props: { request: RequestDetails; run: Run }) {
  const { archive, revision } = useArchive();
  const windows = useWindows();
  const characters = useCharacters(archive.archiveId, revision);
  const { request, run } = props;
  const url = `/api/archives/${archive.archiveId}/requests/${request.id}`;
  const edit = () => windows.show(<RequestModal key={request.id} request={request} />);
  const found = () =>
    windows.show(
      <ConfirmModal
        title={`Found: ${request.label}`}
        text="Finding it deletes the request and its edit history. Nothing records that it was found."
        action="Found it, delete the request"
        onConfirm={() =>
          run(
            () => api(`${url}?expectedVersion=${request.version}`, { method: "DELETE" }),
            "Found. The request is deleted.",
          )
        }
      />,
    );
  return (
    <article className="card" onClick={openUnlessControl(edit)}>
      <div className="top">
        <span className="kind">Missing media</span>
        <span className={`prio ${request.priority}`}>{request.priority.toUpperCase()}</span>
      </div>
      <button className="title" type="button" onClick={edit}>
        {request.description}
      </button>
      <span className="when">{request.wording}</span>
      <div className="chips">
        {request.characters.map((id) => {
          const character = characters[id];
          return (
            <button
              key={id}
              className="chip"
              type="button"
              onClick={() => navigate(characterPath(archive.archiveId, id))}
            >
              <Avatar
                archiveId={archive.archiveId}
                picture={character?.picture ?? null}
                name={character?.knownName ?? "?"}
                size="sm"
              />
              {character?.knownName ?? shortId(id)}
            </button>
          );
        })}
      </div>
      {request.researchNotes ? <span className="hint">Notes: {request.researchNotes}</span> : null}
      {request.status === "unrecoverable" && request.unrecoverableReason ? (
        <span className="hint">Why: {request.unrecoverableReason}</span>
      ) : null}
      <div className="acts">
        <button className="btn" type="button" onClick={found}>
          {request.status === "needed" ? "Found it" : "Found it after all"}
        </button>
        {request.status === "needed" ? (
          <button
            className="btn ghost"
            type="button"
            onClick={() =>
              windows.show(
                <ReasonModal
                  title={`Can't be found: ${request.label}`}
                  hint="Unrecoverable means it is still missing. You can reopen it later."
                  action="Move to Unrecoverable"
                  onSubmit={(reason) =>
                    run(
                      () =>
                        api(`${url}/status`, {
                          method: "POST",
                          json: {
                            expectedVersion: request.version,
                            status: "unrecoverable",
                            unrecoverableReason: reason,
                          },
                        }),
                      "Moved to Unrecoverable.",
                    )
                  }
                />,
              )
            }
          >
            Can't be found
          </button>
        ) : (
          <button
            className="btn ghost"
            type="button"
            onClick={() =>
              run(
                () =>
                  api(`${url}/status`, {
                    method: "POST",
                    json: { expectedVersion: request.version, status: "needed" },
                  }),
                "Moved back to Needed. The description and date stay the same.",
              )
            }
          >
            Reopen
          </button>
        )}
      </div>
    </article>
  );
}

/** What a gap card is called, such as "No date" or "To fill in". */
function gapLabel(card: GapCard): string {
  return card.kind === "custom" && card.field === TO_FILL_IN ? "To fill in" : GAP_LABELS[card.kind];
}

/** Opens the record a card is about, where the missing information is filled in. */
function useOpenSubject(card: GapCard): (() => void) | null {
  const { archive } = useArchive();
  const windows = useWindows();
  const { subject } = card;
  switch (subject.kind) {
    case "artifact":
      return () => windows.openArtifact(subject.id);
    case "event":
      return () => windows.openEvent(subject.id);
    case "account":
      return () => windows.show(<AccountModal accountId={subject.id} />);
    case "character":
      return () => {
        windows.close();
        navigate(characterPath(archive.archiveId, subject.id));
      };
    case "server":
      return () => {
        windows.close();
        navigate(placePath(archive.archiveId, subject.id));
      };
    default:
      return null;
  }
}

/** Asks for the reason Unrecoverable needs, then moves the card there. */
function cantBeFound(card: GapCard, url: string, run: Run) {
  return (
    <ReasonModal
      title={`Can't be found: ${card.subject.label}`}
      hint="Unrecoverable means it is still missing. You can reopen it later."
      action="Move to Unrecoverable"
      initial={card.reason ?? ""}
      onSubmit={(reason) =>
        run(
          () =>
            api(url, {
              method: "PATCH",
              json: { expectedVersion: card.version, status: "unrecoverable", reason },
            }),
          "Moved to Unrecoverable.",
        )
      }
    />
  );
}

/** Confirms that a manual card is done, which deletes it. */
function markDone(card: GapCard, url: string, run: Run) {
  return (
    <ConfirmModal
      title={`Done: ${card.subject.label}`}
      text="Marking it done deletes the card and its edit history. Nothing records that it was done."
      action="Mark done"
      onConfirm={() =>
        run(
          () => api(`${url}?expectedVersion=${card.version}`, { method: "DELETE" }),
          "Done. The card is deleted.",
        )
      }
    />
  );
}

function GapCardView(props: { card: GapCard; run: Run }) {
  const { archive } = useArchive();
  const windows = useWindows();
  const { card, run } = props;
  const url = `/api/archives/${archive.archiveId}/backlog/${card.id}`;
  const manual = !card.derived;
  const edit = () => windows.show(<GapCardModal key={card.id} card={card} run={run} />);
  const text = manual ? card.reason : GAP_TEXT[card.kind];
  return (
    <article className="card" onClick={openUnlessControl(edit)}>
      <div className="top">
        <span className="kind">{gapLabel(card)}</span>
        <span className={`prio ${card.priority}`}>{card.priority.toUpperCase()}</span>
      </div>
      <button className="title" type="button" onClick={edit}>
        {card.subject.label}
      </button>
      {text ? <span className="hint">{text}</span> : null}
      {!manual && card.reason ? (
        <span className="hint">
          {card.status === "unrecoverable" ? "Why" : "Notes"}: {card.reason}
        </span>
      ) : null}
      {card.status === "needed" && !manual ? (
        <span className="hint">Clears by itself when the information is added.</span>
      ) : null}
      {card.status === "needed" && manual ? (
        <div className="acts">
          <button
            className="btn ghost"
            type="button"
            onClick={() => windows.show(markDone(card, url, run))}
          >
            Mark done
          </button>
        </div>
      ) : null}
      {card.status === "unrecoverable" ? (
        <div className="acts">
          <button
            className="btn ghost"
            type="button"
            onClick={() =>
              run(
                () =>
                  api(url, {
                    method: "PATCH",
                    json: { expectedVersion: card.version, status: "needed" },
                  }),
                "Moved back to Needed.",
              )
            }
          >
            Reopen
          </button>
        </div>
      ) : null}
    </article>
  );
}

/**
 * A gap card's window: its priority and notes, a way to open the record and
 * fill in what is missing, and its moves. A manual card's reason says what
 * to research, so it cannot be left empty.
 */
function GapCardModal(props: { card: GapCard; run: Run }) {
  const { archive } = useArchive();
  const windows = useWindows();
  const { card, run } = props;
  const url = `/api/archives/${archive.archiveId}/backlog/${card.id}`;
  const manual = !card.derived;
  const openSubject = useOpenSubject(card);
  const [priority, setPriority] = useState(card.priority);
  const [reason, setReason] = useState(card.reason ?? "");
  const [busy, setBusy] = useState(false);
  const unchanged = priority === card.priority && reason.trim() === (card.reason ?? "");
  const needsReason = manual || card.status === "unrecoverable";
  const save = async () => {
    setBusy(true);
    const ok = await run(
      () =>
        api(url, {
          method: "PATCH",
          json: { expectedVersion: card.version, priority, reason: reason.trim() || null },
        }),
      "Saved the card.",
    );
    setBusy(false);
    if (ok) windows.close();
  };
  return (
    <Modal
      title={`${gapLabel(card)}: ${card.subject.label}`}
      onClose={windows.close}
      footer={
        <>
          {card.status === "needed" && manual ? (
            <button
              className="btn ghost"
              type="button"
              onClick={() => windows.show(markDone(card, url, run))}
            >
              Mark done
            </button>
          ) : null}
          {card.status === "needed" ? (
            <button
              className="btn ghost"
              type="button"
              onClick={() => windows.show(cantBeFound(card, url, run))}
            >
              Can't be found
            </button>
          ) : (
            <button
              className="btn ghost"
              type="button"
              disabled={busy}
              onClick={async () => {
                if (
                  await run(
                    () =>
                      api(url, {
                        method: "PATCH",
                        json: { expectedVersion: card.version, status: "needed" },
                      }),
                    "Moved back to Needed.",
                  )
                )
                  windows.close();
              }}
            >
              Reopen
            </button>
          )}
          <button
            className="btn primary"
            type="button"
            disabled={unchanged || busy || (needsReason && !reason.trim())}
            onClick={save}
          >
            Save
          </button>
        </>
      }
    >
      <div className="content">
        {!manual ? (
          <p className="hint" style={{ margin: 0 }}>
            {GAP_TEXT[card.kind]} This card clears by itself once that is filled in.
          </p>
        ) : null}
        {openSubject ? (
          <button
            className="btn"
            type="button"
            style={{ justifySelf: "start" }}
            onClick={openSubject}
          >
            Open the {SUBJECT_NAMES[card.subject.kind]} to fill it in
          </button>
        ) : null}
        <div className="grid2">
          <label className="field">
            <span>Priority</span>
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value as GapCard["priority"])}
            >
              {PRIORITIES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>
            {card.status === "unrecoverable"
              ? "Why it can't be found"
              : manual
                ? "What to research"
                : "Notes (optional)"}
          </span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

/** Confirms a change that cannot be undone, such as deleting a found request. */
function ConfirmModal(props: {
  title: string;
  text: string;
  action: string;
  onConfirm(): Promise<boolean>;
}) {
  const windows = useWindows();
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={props.title}
      onClose={windows.close}
      footer={
        <>
          <button className="btn ghost" type="button" onClick={windows.close}>
            Cancel
          </button>
          <button
            className="btn danger"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              if (await props.onConfirm()) windows.close();
              setBusy(false);
            }}
          >
            {props.action}
          </button>
        </>
      }
    >
      <div className="content">
        <p style={{ margin: 0 }}>{props.text}</p>
      </div>
    </Modal>
  );
}

/** Asks for the reason a move needs, such as why something can't be found. */
function ReasonModal(props: {
  title: string;
  hint: string;
  action: string;
  initial?: string;
  onSubmit(reason: string): Promise<boolean>;
}) {
  const windows = useWindows();
  const [reason, setReason] = useState(props.initial ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={props.title}
      onClose={windows.close}
      footer={
        <>
          <button className="btn ghost" type="button" onClick={windows.close}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!reason.trim() || busy}
            onClick={async () => {
              setBusy(true);
              if (await props.onSubmit(reason.trim())) windows.close();
              setBusy(false);
            }}
          >
            {props.action}
          </button>
        </>
      }
    >
      <div className="content">
        <label className="field">
          <span>Why (required)</span>
          <input value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <p className="hint" style={{ margin: 0 }}>
          {props.hint}
        </p>
      </div>
    </Modal>
  );
}

function FlagDateModal() {
  const { archive, changed, toast } = useArchive();
  const windows = useWindows();
  const [artifact, setArtifact] = useState<ChosenArtifact | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/archives/${archive.archiveId}/backlog/flags`, {
        method: "POST",
        json: { kind: "date_research", subjectId: artifact!.id, reason },
      });
      changed();
      toast("Added to the board.");
      windows.close();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Flag a date for research"
      onClose={windows.close}
      footer={
        <>
          <button className="btn ghost" type="button" onClick={windows.close}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!artifact || !reason.trim() || busy}
            onClick={submit}
          >
            Flag
          </button>
        </>
      }
    >
      <div className="content">
        <ArtifactChooser
          archiveId={archive.archiveId}
          label="Artifact"
          value={artifact}
          onChange={setArtifact}
        />
        <label className="field">
          <span>Why the date needs research</span>
          <input
            value={reason}
            placeholder="The phone's clock was wrong"
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
