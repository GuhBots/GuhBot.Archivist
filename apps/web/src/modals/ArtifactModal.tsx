import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ArtifactDetails, mediaUrl } from "../api.js";
import { CharacterChips } from "../components/CharacterChips.js";
import { DateField } from "../components/DateField.js";
import { FullMedia } from "../components/Media.js";
import { type Picked, Picker, unfinishedError, unfinishedPicker } from "../components/Picker.js";
import { PlacePicker, useLinkedPlaces } from "../components/PlacePicker.js";
import { basisText, byteText, dayText, shortId } from "../format.js";
import { navigate, viewPath } from "../router.js";
import { useWindows } from "../Shell.js";
import { useArchive } from "../state.js";
import { ErrorNote, Modal } from "../ui.js";

type Loaded = ArtifactDetails & { names: Record<string, string> };

interface Nav {
  ids: string[];
  index: number;
  title?: string;
}

/** Preloads an artifact's picture, so stepping to it shows it at once. Video and audio load when played. */
function preloadMedia(archiveId: string, artifact: Loaded): void {
  const { media } = artifact;
  if (!media.readable || !media.mimeType.startsWith("image/")) return;
  const still = media.hasPreview && media.mimeType !== "image/gif";
  new Image().src = mediaUrl(archiveId, media.id, still);
}

/**
 * An artifact's full details, with editing and deletion, and steps through
 * an album when opened from one. The window stays open while stepping: it
 * shows each artifact as soon as it is loaded, keeps the ones it has seen,
 * and loads the next and previous ones ahead of time.
 */
export function ArtifactModal(props: { id: string; nav?: Nav }) {
  const { archive, toast, changed, setPosition } = useArchive();
  const windows = useWindows();
  const cache = useRef(new Map<string, Loaded>());
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const base = `/api/archives/${archive.archiveId}/artifacts/${props.id}`;
  // The artifact on screen now. A slow answer for one already stepped past is dropped.
  const current = useRef(props.id);
  current.current = props.id;
  const artifact = loaded?.id === props.id ? loaded : (cache.current.get(props.id) ?? null);

  const fetchArtifact = useCallback(
    async (id: string) => {
      const result = await api<Loaded>(`/api/archives/${archive.archiveId}/artifacts/${id}`);
      cache.current.set(id, result);
      return result;
    },
    [archive.archiveId],
  );
  const load = useCallback(() => {
    const id = props.id;
    fetchArtifact(id)
      .then((result) => current.current === id && setLoaded(result))
      .catch((failure: unknown) => current.current === id && setError(failure));
  }, [props.id, fetchArtifact]);

  // Each artifact starts out of edit mode and is refreshed, even when it was already loaded.
  useEffect(() => {
    setEditing(false);
    setConfirmDelete(false);
    setError(null);
    load();
  }, [load]);

  // The neighbors load in the background, pictures included.
  useEffect(() => {
    if (!props.nav) return;
    for (const offset of [1, -1]) {
      const id = props.nav.ids[props.nav.index + offset];
      if (!id) continue;
      const known = cache.current.get(id);
      if (known) continue;
      fetchArtifact(id)
        .then((result) => preloadMedia(archive.archiveId, result))
        .catch(() => undefined);
    }
  }, [props.nav, fetchArtifact, archive.archiveId]);

  const step = useCallback(
    (by: number) => {
      if (!props.nav) return;
      const index = props.nav.index + by;
      if (index < 0 || index >= props.nav.ids.length) return;
      windows.openArtifact(props.nav.ids[index]!, { ...props.nav, index });
    },
    [props.nav, windows],
  );
  const onKey = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (editing || target.closest("input:not([type=checkbox]), textarea, select")) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    },
    [editing, step],
  );

  const title = props.nav
    ? `${props.nav.title ? `${props.nav.title} · ` : ""}${props.nav.index + 1} of ${props.nav.ids.length}`
    : `Artifact ${shortId(props.id)}`;

  const navButtons = props.nav ? (
    <>
      <button
        className="btn"
        type="button"
        aria-label="Previous artifact"
        disabled={props.nav.index === 0}
        onClick={() => step(-1)}
      >
        ‹
      </button>
      <button
        className="btn"
        type="button"
        aria-label="Next artifact"
        disabled={props.nav.index === props.nav.ids.length - 1}
        onClick={() => step(1)}
      >
        ›
      </button>
      <span className="grow" />
    </>
  ) : null;

  if (!artifact) {
    // The same window, with placeholders where the artifact will be.
    return (
      <Modal title={title} wide onClose={windows.close} onKey={onKey} footer={navButtons}>
        <div className="content">
          {error ? (
            <ErrorNote error={error} />
          ) : (
            <div className="detail" aria-busy="true" aria-label="Loading the artifact">
              <div className="media-box skeleton" />
              <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
                <span className="skeleton line" />
                <span className="skeleton line short" />
                <span className="skeleton block" />
              </div>
            </div>
          )}
        </div>
      </Modal>
    );
  }

  const selected = artifact.dates.selected;
  const day = selected?.date.archiveDay ?? null;

  const save = async (patch: Record<string, unknown>) => {
    try {
      const updated = await api<ArtifactDetails>(base, {
        method: "PATCH",
        json: { ...patch, expectedVersion: artifact.version },
      });
      const next = { ...artifact, ...updated, names: { ...artifact.names } };
      cache.current.set(artifact.id, next);
      setLoaded(next);
      changed();
      load();
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "stale_version") {
        toast("Someone else changed this artifact. Here it is as it is now.");
        load();
      }
      setError(failure);
      return false;
    }
  };

  if (confirmDelete) {
    return (
      <Modal
        title={`Delete artifact ${shortId(artifact.id)}?`}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <button className="btn ghost" type="button" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
            <button
              className="btn danger"
              type="button"
              onClick={async () => {
                try {
                  await api(`${base}?expectedVersion=${artifact.version}`, { method: "DELETE" });
                  toast("Deleted.");
                  changed();
                  windows.close();
                } catch (failure) {
                  setError(failure);
                  setConfirmDelete(false);
                }
              }}
            >
              Delete permanently
            </button>
          </>
        }
      >
        <div className="content">
          <p style={{ margin: 0 }}>
            This is permanent. There is no trash or undo. Its links and its own edit history are
            removed. The media file stays in the archive, and any Discord announcement stays posted.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={title}
      wide
      onClose={windows.close}
      onKey={onKey}
      footer={
        editing ? (
          <>
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button className="btn primary" type="submit" form={EDIT_FORM}>
              Save
            </button>
          </>
        ) : (
          <>
            {navButtons}
            <button className="btn danger" type="button" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
            {day ? (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setPosition(day);
                  window.dispatchEvent(
                    new CustomEvent("archivist:jump", { detail: { day, zoom: "day" } }),
                  );
                  windows.close();
                  navigate(viewPath(archive.archiveId, "timeline"));
                }}
              >
                Show on timeline
              </button>
            ) : null}
            <button className="btn primary" type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
          </>
        )
      }
    >
      <div className="content">
        <div className="detail">
          <FullMedia archiveId={archive.archiveId} artifact={artifact} />
          {editing ? (
            <EditArtifact
              artifact={artifact}
              onError={setError}
              onSave={async (patch) => {
                setError(null);
                if (await save(patch)) {
                  setEditing(false);
                  toast("Saved.");
                }
              }}
            />
          ) : (
            <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
              <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{artifact.description}</p>
              <dl className="kv">
                <dt>Characters</dt>
                <dd>
                  <CharacterChips
                    ids={artifact.links.characters}
                    names={artifact.names}
                    empty="No characters linked yet"
                  />
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={artifact.unidentifiedCharacters}
                      onChange={(event) =>
                        save({ unidentifiedCharacters: event.target.checked }).then(
                          (ok) =>
                            ok &&
                            toast(
                              event.target.checked
                                ? "Marked: a character in it is not identified yet."
                                : "Cleared.",
                            ),
                        )
                      }
                    />
                    A character in this is not identified yet
                  </label>
                </dd>
                <dt>Place</dt>
                <dd>
                  {[...artifact.links.servers, ...artifact.links.channels]
                    .map((id) => artifact.names[id] ?? shortId(id))
                    .join(", ") || "Unassigned"}
                </dd>
                <dt>Events</dt>
                <dd>
                  {artifact.links.events.length
                    ? artifact.links.events.map((id, i) => (
                        <span key={id}>
                          {i ? ", " : ""}
                          <button
                            className="linkish"
                            type="button"
                            onClick={() => windows.openEvent(id)}
                          >
                            {artifact.names[id] ?? shortId(id)}
                          </button>
                        </span>
                      ))
                    : "None linked"}
                </dd>
                <dt>File</dt>
                <dd>
                  {artifact.media.originalFilename} · {byteText(artifact.media.byteLength)}
                  {artifact.media.readable ? "" : ", cannot be read (kept as uploaded)"}
                </dd>
                <dt>Source</dt>
                <dd>
                  {artifact.source.provider === "drive"
                    ? "Google Drive"
                    : artifact.source.provider === "web_upload"
                      ? "Uploaded on the website"
                      : "Discord attachment"}
                </dd>
              </dl>
              <table className="dates">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Value</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      Exact{" "}
                      {selected?.basis === "exact" ? <span className="inuse">in use</span> : null}
                    </td>
                    <td>
                      {artifact.dates.exact ? dayText(artifact.dates.exact.date.archiveDay) : "—"}
                    </td>
                    <td>{artifact.dates.exact ? artifact.dates.exact.date.originalText : ""}</td>
                  </tr>
                  <tr>
                    <td>
                      Estimated{" "}
                      {selected?.basis === "estimated" ? (
                        <span className="inuse">in use</span>
                      ) : null}
                    </td>
                    <td>
                      {artifact.dates.estimated
                        ? dayText(artifact.dates.estimated.date.archiveDay)
                        : "—"}
                    </td>
                    <td>{artifact.dates.estimated?.reason ?? ""}</td>
                  </tr>
                  <tr>
                    <td>
                      File{" "}
                      {selected?.basis === "file" ? <span className="inuse">in use</span> : null}
                    </td>
                    <td>{artifact.dates.file ? dayText(artifact.dates.file.archiveDay) : "—"}</td>
                    <td>
                      {artifact.dates.file
                        ? FILE_DATE_SOURCES[artifact.media.fileDateSource ?? "embedded"]
                        : ""}
                    </td>
                  </tr>
                </tbody>
              </table>
              <span className="hint">
                {selected
                  ? `Shown on ${dayText(day)} (${basisText(selected.basis)}).`
                  : "No date yet: it is in the undated section."}
              </span>
            </div>
          )}
        </div>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

/** How each kind of file date was found, all below a contributor's exact or estimated date. */
const FILE_DATE_SOURCES: Record<"embedded" | "filename" | "modified", string> = {
  embedded: "Embedded in the file, not verified",
  filename: "From the file's name, not verified",
  modified: "When the uploader's computer last changed the file, not verified",
};

/** The edit form's ID, so the window's footer can hold its Save button. */
const EDIT_FORM = "edit-artifact";

function EditArtifact(props: {
  artifact: Loaded;
  onSave(patch: Record<string, unknown>): void;
  onError(error: unknown): void;
}) {
  const { archive } = useArchive();
  const { artifact } = props;
  const [description, setDescription] = useState(artifact.description);
  const [exact, setExact] = useState(artifact.dates.exact?.date.originalText ?? "");
  const [estimate, setEstimate] = useState(artifact.dates.estimated?.date.originalText ?? "");
  const [reason, setReason] = useState(artifact.dates.estimated?.reason ?? "");
  const named = (ids: string[]): Picked[] =>
    ids.map((id) => ({ id, label: artifact.names[id] ?? id.slice(0, 8) }));
  const [characters, setCharacters] = useState<Picked[]>(named(artifact.links.characters));
  const [events, setEvents] = useState<Picked[]>(named(artifact.links.events));
  const [places, setPlaces] = useLinkedPlaces(archive.archiveId, artifact.links, artifact.names);
  const form = useRef<HTMLFormElement>(null);
  const diff = (before: string[], after: { id: string }[]) => ({
    add: after.map((p) => p.id).filter((id) => !before.includes(id)),
    remove: before.filter((id) => !after.some((p) => p.id === id)),
  });
  const save = () => {
    const left = unfinishedPicker(form.current);
    if (left) {
      props.onError(unfinishedError(left));
      return;
    }
    const c = diff(artifact.links.characters, characters);
    const e = diff(artifact.links.events, events);
    const sv = diff(
      artifact.links.servers,
      places.filter((place) => place.kind === "server"),
    );
    const ch = diff(
      artifact.links.channels,
      places.filter((place) => place.kind === "channel"),
    );
    const patch: Record<string, unknown> = {};
    if (description !== artifact.description) patch.description = description;
    if (exact !== (artifact.dates.exact?.date.originalText ?? ""))
      patch.exactDate = exact.trim() ? exact : null;
    if (
      estimate !== (artifact.dates.estimated?.date.originalText ?? "") ||
      reason !== (artifact.dates.estimated?.reason ?? "")
    ) {
      patch.estimatedDate = estimate.trim() ? { day: estimate, reason } : null;
    }
    if (c.add.length || e.add.length || sv.add.length || ch.add.length) {
      patch.addLinks = { characters: c.add, events: e.add, servers: sv.add, channels: ch.add };
    }
    if (c.remove.length || e.remove.length || sv.remove.length || ch.remove.length) {
      patch.removeLinks = {
        characters: c.remove,
        events: e.remove,
        servers: sv.remove,
        channels: ch.remove,
      };
    }
    props.onSave(patch);
  };
  return (
    <form
      ref={form}
      id={EDIT_FORM}
      style={{ display: "grid", gap: 10 }}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label className="field">
        <span>Description</span>
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <Picker
        archiveId={archive.archiveId}
        kind="character"
        label="Characters"
        value={characters}
        onChange={setCharacters}
        allowCreate
      />
      <PlacePicker
        archiveId={archive.archiveId}
        label="Where it is from"
        value={places}
        onChange={setPlaces}
      />
      <Picker
        archiveId={archive.archiveId}
        kind="event"
        label="Events"
        value={events}
        onChange={setEvents}
        allowCreate
      />
      <DateField
        archiveId={archive.archiveId}
        label="Exact date"
        value={exact}
        onChange={setExact}
        placeholder="Jul 15 2019 6:30pm"
      />
      <DateField
        archiveId={archive.archiveId}
        label="Estimated day"
        value={estimate}
        onChange={setEstimate}
        placeholder="early Jul 2019"
      />
      {estimate.trim() ? (
        <label className="field">
          <span>Why you estimate that day</span>
          <input value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
      ) : null}
      <p className="hint" style={{ margin: 0 }}>
        If someone else saves first, you see their changes and choose again. Nothing is overwritten
        silently.
      </p>
    </form>
  );
}
