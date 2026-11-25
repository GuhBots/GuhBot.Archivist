import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type GapCard, type RequestDetails } from "../api.js";
import { ArtifactChooser, type ChosenArtifact } from "../components/ArtifactChooser.js";
import { TO_FILL_IN } from "../components/quick-create.js";
import { useCharacters } from "../components/use-names.js";
import { shortId } from "../format.js";
import { characterPath, navigate, placePath } from "../router.js";
import { useWindows } from "../Shell.js";
import { loadLocal, saveLocal, useArchive } from "../state.js";
import { Avatar, ErrorNote, Modal } from "../ui.js";
import { AddMenu } from "../components/AddMenu.js";
import { ViewFrame } from "./ViewFrame.js";

/**
 * The research board: what the archive is missing, in Needed, Resolved, and
 * Unrecoverable. Gap cards follow the data and clear by themselves when the
 * information is added. Missing-media requests resolve when a contributor
 * links the artifact that has the media. Nobody is assigned anything.
 */

type Show = "all" | "requests" | "gaps";
type Status = RequestDetails["status"];

const BUCKETS: [Status, string][] = [
  ["needed", "Needed"],
  ["resolved", "Resolved"],
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
            A backlog of what is missing. Gaps clear by themselves when the information is added,
            and a request resolves when you link the artifact that has it. Nobody is assigned
            anything.
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

function RequestCard(props: { request: RequestDetails; run: Run }) {
  const { archive, revision } = useArchive();
  const windows = useWindows();
  const characters = useCharacters(archive.archiveId, revision);
  const { request, run } = props;
  const url = `/api/archives/${archive.archiveId}/requests/${request.id}/status`;
  return (
    <article className="card">
      <div className="top">
        <span className="kind">Missing media</span>
        <span className={`prio ${request.priority}`}>{request.priority.toUpperCase()}</span>
      </div>
      <strong>{request.description}</strong>
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
      {request.foundArtifacts.map((id) => (
        <button
          key={id}
          className="linkish"
          style={{ textAlign: "left" }}
          type="button"
          onClick={() => windows.openArtifact(id)}
        >
          Found in artifact {shortId(id)}
        </button>
      ))}
      <div className="acts">
        {request.status === "needed" ? (
          <>
            <button
              className="btn"
              type="button"
              onClick={() => windows.show(<ResolveModal request={request} />)}
            >
              Link the artifact that has it
            </button>
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
                          api(url, {
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
          </>
        ) : (
          <>
            {request.status === "unrecoverable" ? (
              <button
                className="btn"
                type="button"
                onClick={() => windows.show(<ResolveModal request={request} />)}
              >
                Found it after all
              </button>
            ) : null}
            <button
              className="btn ghost"
              type="button"
              onClick={() =>
                run(
                  () =>
                    api(url, {
                      method: "POST",
                      json: { expectedVersion: request.version, status: "needed" },
                    }),
                  "Moved back to Needed. The description and date stay the same.",
                )
              }
            >
              Reopen
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function GapCardView(props: { card: GapCard; run: Run }) {
  const { archive } = useArchive();
  const windows = useWindows();
  const { card, run } = props;
  const url = `/api/archives/${archive.archiveId}/backlog/${card.id}`;
  const manual = !card.derived;
  const { subject } = card;
  const open =
    subject.kind === "artifact"
      ? () => windows.openArtifact(subject.id)
      : subject.kind === "event"
        ? () => windows.openEvent(subject.id)
        : subject.kind === "character"
          ? () => navigate(characterPath(archive.archiveId, subject.id))
          : subject.kind === "server"
            ? () => navigate(placePath(archive.archiveId, subject.id))
            : null;
  const move = (status: Status, done: string, reason?: string) =>
    run(
      () =>
        api(url, {
          method: "PATCH",
          json: { expectedVersion: card.version, status, reason },
        }),
      done,
    );
  const text = manual ? card.reason : GAP_TEXT[card.kind];
  return (
    <article className="card">
      <div className="top">
        <span className="kind">
          {card.kind === "custom" && card.field === TO_FILL_IN
            ? "To fill in"
            : GAP_LABELS[card.kind]}
        </span>
        <span className={`prio ${card.priority}`}>{card.priority.toUpperCase()}</span>
      </div>
      {open ? (
        <button className="linkish" style={{ textAlign: "left" }} type="button" onClick={open}>
          {subject.label}
        </button>
      ) : (
        <strong>{subject.label}</strong>
      )}
      {text ? <span className="hint">{text}</span> : null}
      {card.status === "unrecoverable" && !manual && card.reason ? (
        <span className="hint">Why: {card.reason}</span>
      ) : null}
      {card.status === "needed" && !manual ? (
        <span className="hint">Clears by itself when the information is added.</span>
      ) : null}
      {card.status === "needed" && manual ? (
        <div className="acts">
          <button
            className="btn ghost"
            type="button"
            onClick={() => move("resolved", "Marked done.")}
          >
            Mark done
          </button>
        </div>
      ) : null}
      {card.status === "unrecoverable" || (card.status === "resolved" && manual) ? (
        <div className="acts">
          <button
            className="btn ghost"
            type="button"
            onClick={() => move("needed", "Moved back to Needed.")}
          >
            Reopen
          </button>
        </div>
      ) : null}
    </article>
  );
}

/** Asks for the reason a move needs, such as why something can't be found. */
function ReasonModal(props: {
  title: string;
  hint: string;
  action: string;
  onSubmit(reason: string): Promise<boolean>;
}) {
  const windows = useWindows();
  const [reason, setReason] = useState("");
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

function ResolveModal(props: { request: RequestDetails }) {
  const { archive, changed, toast } = useArchive();
  const windows = useWindows();
  const [found, setFound] = useState<ChosenArtifact | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/archives/${archive.archiveId}/requests/${props.request.id}/status`, {
        method: "POST",
        json: {
          expectedVersion: props.request.version,
          status: "resolved",
          foundArtifacts: [found!.id],
        },
      });
      changed();
      toast("Resolved. The request keeps its own description and date.");
      windows.close();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Found: ${props.request.label}`}
      onClose={windows.close}
      footer={
        <>
          <button className="btn ghost" type="button" onClick={windows.close}>
            Cancel
          </button>
          <button className="btn primary" type="button" disabled={!found || busy} onClick={submit}>
            Link and resolve
          </button>
        </>
      }
    >
      <div className="content">
        <p className="hint" style={{ margin: 0 }}>
          Linking the artifact that has it resolves the request. The request keeps its own
          description and date.
        </p>
        <ArtifactChooser
          archiveId={archive.archiveId}
          label="Found in"
          value={found}
          onChange={setFound}
        />
        <ErrorNote error={error} />
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
