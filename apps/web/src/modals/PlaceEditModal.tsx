import { useCallback, useEffect, useState } from "react";
import { PALETTE } from "../../../server/src/archivist/palette.js";
import { api, ApiError, type EntityView, type HistoryEntry, mediaUrl } from "../api.js";
import { DateField } from "../components/DateField.js";
import { FileDrop, IMAGE_ACCEPT } from "../components/FileDrop.js";
import { blockersText, type HistoryChange, HistoryRows } from "../components/History.js";
import { dayText } from "../format.js";
import { navigate, viewPath } from "../router.js";
import { useWindows } from "../Shell.js";
import { useArchive } from "../state.js";
import { ErrorNote, Modal } from "../ui.js";
import { DeleteModal } from "./DeleteModal.js";

type Place = Extract<EntityView, { kind: "server" | "channel" }>;

/**
 * Edits a server or group chat directly: its name, Discord ID, lane color,
 * dated names and icons, and a server's channels, and deletes it once
 * nothing links to it. Each change saves at once with the version just
 * loaded, so nothing overwrites someone else's edit.
 */
export function PlaceEditModal(props: { kind: "server" | "channel"; id: string }) {
  const { archive, toast, changed } = useArchive();
  const windows = useWindows();
  const [place, setPlace] = useState<Place | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [label, setLabel] = useState("");
  const [discordId, setDiscordId] = useState("");
  const [newName, setNewName] = useState("");
  const [newNameDate, setNewNameDate] = useState("");
  const [iconDate, setIconDate] = useState("");
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [newChannel, setNewChannel] = useState("");
  const base = `/api/archives/${archive.archiveId}/entities/${props.kind}/${props.id}`;

  const load = useCallback(async () => {
    const record = await api<Place>(base);
    setPlace(record);
    setLabel(record.label);
    setDiscordId(record.discordId ?? "");
    return record;
  }, [base]);
  useEffect(() => {
    load().catch(setError);
  }, [load]);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await action();
      await load();
      changed();
      toast(done);
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "stale_version") {
        try {
          await load();
          setError(
            new Error("Someone else changed this place. Its current values are shown; try again."),
          );
        } catch (refreshFailure) {
          setError(refreshFailure);
        }
      } else setError(failure);
    }
  };

  if (!place) {
    return (
      <Modal title="Edit place" onClose={windows.close}>
        <div className="content">{error ? <ErrorNote error={error} /> : "Loading…"}</div>
      </Modal>
    );
  }
  const nameKind = place.kind === "server" ? "server_name" : "channel_name";
  const names = place.history.filter((entry) => entry.kind === nameKind);
  const icons =
    place.kind === "server" ? place.history.filter((entry) => entry.kind === "server_icon") : [];
  const isGroupChat = place.kind === "channel" && place.channelKind === "group_chat";
  const removeEntry = (entry: HistoryEntry, done: string) =>
    run(
      () =>
        api(
          `${base}/history/${entry.id}?historyKind=${entry.kind}&expectedVersion=${place.version}`,
          { method: "DELETE" },
        ),
      done,
    );
  const editEntry = async (entry: HistoryEntry, change: HistoryChange) => {
    let saved = false;
    await run(async () => {
      await api(`${base}/history/${entry.id}`, {
        method: "PATCH",
        json: { historyKind: entry.kind, expectedVersion: place.version, ...change },
      });
      saved = true;
    }, "Saved.");
    return saved;
  };
  const blocked = Object.keys(place.blockers).length > 0;
  const kindName = isGroupChat ? "group chat" : place.kind === "server" ? "server" : "channel";
  const reopen = () => windows.show(<PlaceEditModal kind={props.kind} id={props.id} />);

  return (
    <Modal
      title={`Edit ${place.label}`}
      wide
      onClose={windows.close}
      footer={
        <>
          <button
            className="btn danger"
            type="button"
            disabled={blocked}
            title={blocked ? "Remove what links to it first" : undefined}
            onClick={() =>
              windows.show(
                <DeleteModal
                  what={`the ${kindName} ${place.label}`}
                  path={`/entities/${props.kind}/${place.id}`}
                  version={place.version}
                  onKeep={reopen}
                  onDeleted={() => navigate(viewPath(archive.archiveId, "places"))}
                />,
              )
            }
          >
            Delete {kindName}
          </button>
          <span className="grow" />
          <button className="btn primary" type="button" onClick={windows.close}>
            Done
          </button>
        </>
      }
    >
      <div className="content">
        {blocked ? (
          <p className="hint" style={{ margin: 0 }}>
            To delete this {kindName}, first remove what links to it: {blockersText(place.blockers)}
            .
          </p>
        ) : null}
        <div className="grid2">
          <label className="field">
            <span>Name before any dated name</span>
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label className="field">
            <span>Discord ID (optional)</span>
            <input
              value={discordId}
              inputMode="numeric"
              onChange={(event) => setDiscordId(event.target.value)}
            />
            {place.discordCreatedAt ? (
              <span className="hint">
                Created {dayText(place.discordCreatedAt.slice(0, 10))}, from its ID
              </span>
            ) : null}
          </label>
        </div>
        <div className="field">
          <span>Lane color</span>
          <div className="swatches" role="radiogroup" aria-label="Lane color">
            {[...new Set([place.color, ...PALETTE])].map((color) => (
              <label key={color} title={color}>
                <input
                  type="radio"
                  name="lane-color"
                  checked={place.color === color}
                  onChange={() =>
                    run(
                      () =>
                        api(base, {
                          method: "PATCH",
                          json: { expectedVersion: place.version, color },
                        }),
                      "Saved the lane color.",
                    )
                  }
                />
                <span style={{ background: color }} />
              </label>
            ))}
          </div>
        </div>
        <div>
          <button
            className="btn"
            type="button"
            disabled={label === place.label && discordId === (place.discordId ?? "")}
            onClick={() =>
              run(
                () =>
                  api(base, {
                    method: "PATCH",
                    json: {
                      expectedVersion: place.version,
                      label,
                      discordId: discordId.trim() ? discordId.trim() : null,
                    },
                  }),
                "Saved.",
              )
            }
          >
            Save name and ID
          </button>
        </div>

        <div className="field">
          <span>Names, each with the day it started</span>
          <HistoryRows
            entries={names}
            editing
            empty={`No dated names yet; it goes by "${place.label}".`}
            dates={(entry) =>
              entry.date ? `from ${dayText(entry.date.archiveDay)}` : "date unknown"
            }
            render={(entry) => entry.name}
            onRemove={(entry) => removeEntry(entry, "Removed the name.")}
            onEdit={editEntry}
          />
          <div className="grid2">
            <label className="field">
              <span>New name</span>
              <input value={newName} onChange={(event) => setNewName(event.target.value)} />
            </label>
            <DateField
              archiveId={archive.archiveId}
              label="From (optional)"
              value={newNameDate}
              onChange={setNewNameDate}
              placeholder="Mar 14 2020"
            />
          </div>
          <button
            className="btn"
            type="button"
            style={{ justifySelf: "start" }}
            disabled={!newName.trim()}
            onClick={() =>
              run(async () => {
                await api(`${base}/history`, {
                  method: "POST",
                  json: {
                    kind: nameKind,
                    expectedVersion: place.version,
                    name: newName,
                    date: newNameDate.trim() || undefined,
                  },
                });
                setNewName("");
                setNewNameDate("");
              }, "Added the name.")
            }
          >
            Add the name
          </button>
        </div>

        {place.kind === "server" || isGroupChat ? (
          <div className="field">
            <span>{isGroupChat ? "Icon" : "Icons, each with the day it started"}</span>
            <div className="chips" style={{ alignItems: "center" }}>
              {isGroupChat && place.kind === "channel" && place.iconMediaId ? (
                <span className="av lg">
                  <img src={mediaUrl(archive.archiveId, place.iconMediaId)} alt="Current icon" />
                </span>
              ) : null}
            </div>
            {isGroupChat ? null : (
              <HistoryRows
                entries={icons}
                editing
                empty="No icons yet."
                render={(entry) => (
                  <span className="av sm">
                    <img
                      src={mediaUrl(archive.archiveId, entry.mediaId!)}
                      alt={`Icon ${entry.date ? `from ${dayText(entry.date.archiveDay)}` : ""}`}
                    />
                  </span>
                )}
                onRemove={(entry) => removeEntry(entry, "Removed the icon.")}
                onEdit={editEntry}
              />
            )}
            <div className="grid2">
              <FileDrop
                label={isGroupChat ? "Replace the icon" : "Add an icon"}
                accept={IMAGE_ACCEPT}
                file={iconFile}
                onFile={setIconFile}
              />
              {isGroupChat ? null : (
                <DateField
                  archiveId={archive.archiveId}
                  label="From (optional)"
                  value={iconDate}
                  onChange={setIconDate}
                  placeholder="Sep 1 2020"
                />
              )}
            </div>
            <button
              className="btn"
              type="button"
              style={{ justifySelf: "start" }}
              disabled={!iconFile}
              onClick={() =>
                run(async () => {
                  const form = new FormData();
                  form.append("purpose", isGroupChat ? "icon" : "server_icon");
                  form.append("expectedVersion", String(place.version));
                  if (!isGroupChat && iconDate.trim()) form.append("date", iconDate.trim());
                  form.append("file", iconFile!, iconFile!.name);
                  await api(`${base}/picture`, { method: "POST", form });
                  setIconFile(null);
                  setIconDate("");
                }, "Saved the icon.")
              }
            >
              Upload
            </button>
          </div>
        ) : null}

        {place.kind === "server" ? (
          <div className="field">
            <span>Channels</span>
            {place.channels.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                onRun={run}
                onDelete={() => {
                  if (Object.keys(channel.blockers).length) {
                    setError(
                      new Error(
                        `#${channel.label} is still linked from ${blockersText(channel.blockers)}. Remove those links first.`,
                      ),
                    );
                    return;
                  }
                  windows.show(
                    <DeleteModal
                      what={`the channel #${channel.label}`}
                      path={`/entities/channel/${channel.id}`}
                      version={channel.version}
                      onKeep={reopen}
                      onDeleted={reopen}
                    />,
                  );
                }}
              />
            ))}
            <div className="jump">
              <input
                aria-label="New channel name"
                placeholder="New channel name"
                value={newChannel}
                onChange={(event) => setNewChannel(event.target.value)}
              />
              <button
                className="btn"
                type="button"
                disabled={!newChannel.trim()}
                onClick={() =>
                  run(async () => {
                    await api(`/api/archives/${archive.archiveId}/entities/channel`, {
                      method: "POST",
                      json: {
                        kind: "guild_channel",
                        label: newChannel.replace(/^#/, ""),
                        serverId: place.id,
                      },
                    });
                    setNewChannel("");
                  }, "Added the channel.")
                }
              >
                Add a channel
              </button>
            </div>
          </div>
        ) : null}
        <p className="hint" style={{ margin: 0 }}>
          The timeline shows whichever name and icon applied on each day.
        </p>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

function ChannelRow(props: {
  channel: Extract<EntityView, { kind: "channel" }>;
  onRun(action: () => Promise<unknown>, done: string): Promise<void>;
  onDelete(): void;
}) {
  const { archive } = useArchive();
  const [label, setLabel] = useState(props.channel.label);
  useEffect(() => setLabel(props.channel.label), [props.channel.label, props.channel.version]);
  const url = `/api/archives/${archive.archiveId}/entities/channel/${props.channel.id}`;
  return (
    <div className="hist-row" style={{ gridTemplateColumns: "minmax(0,1fr) auto 36px" }}>
      <input
        aria-label="Channel name"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
      />
      <button
        className="btn"
        type="button"
        disabled={label === props.channel.label}
        onClick={() =>
          props.onRun(
            () =>
              api(url, {
                method: "PATCH",
                json: { expectedVersion: props.channel.version, label },
              }),
            "Renamed the channel.",
          )
        }
      >
        Rename
      </button>
      <button
        className="btn ghost"
        type="button"
        aria-label={`Delete #${props.channel.label}`}
        onClick={props.onDelete}
      >
        ✕
      </button>
    </div>
  );
}
