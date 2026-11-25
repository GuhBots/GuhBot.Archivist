import { useEffect, useState } from "react";
import { api, query } from "../api.js";
import { useSettled } from "../Shell.js";
import { useArchive } from "../state.js";
import { createChannel, createNamed } from "./quick-create.js";

/** A server, or a channel, thread, or group chat, as an artifact links it. */
export interface PickedPlace {
  kind: "server" | "channel";
  id: string;
  label: string;
  /** For channels: "group chat", or the server's name. */
  detail?: string;
}

interface Hit {
  id: string;
  label: string;
  detail?: string;
}

const fold = (text: string) => text.normalize("NFKC").toLocaleLowerCase().trim();

export function placeLabel(place: PickedPlace): string {
  if (place.kind === "server") return `${place.label} (server)`;
  if (place.detail === "group chat") return `${place.label} (group chat)`;
  return place.detail ? `#${place.label} in ${place.detail}` : `#${place.label}`;
}

/**
 * Chooses where an artifact is from: a server, a channel in one, or a group
 * chat. The timeline puts it in that server's or group chat's lane. A name
 * that is not in the archive yet can become a new server or group chat, or a
 * new channel in a server already chosen here.
 */
export function PlacePicker(props: {
  archiveId: string;
  label: string;
  value: PickedPlace[];
  onChange(value: PickedPlace[]): void;
}) {
  const { changed, toast } = useArchive();
  const [text, setText] = useState("");
  const [hits, setHits] = useState<PickedPlace[]>([]);
  const [busy, setBusy] = useState(false);
  const typed = useSettled(text.trim().replace(/^#/, ""), 180);
  const base = `/api/archives/${props.archiveId}/entities`;

  useEffect(() => {
    if (!typed) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const signal = controller.signal;
    Promise.all([
      api<{ items: Hit[] }>(`${base}/server${query({ q: typed, limit: 6 })}`, { signal }),
      api<{ items: Hit[] }>(`${base}/channel${query({ q: typed, limit: 8 })}`, { signal }),
    ])
      .then(([servers, channels]) =>
        setHits([
          ...servers.items.map((hit) => ({ kind: "server" as const, ...hit })),
          ...channels.items.map((hit) => ({ kind: "channel" as const, ...hit })),
        ]),
      )
      .catch(() => undefined);
    return () => controller.abort();
  }, [typed, base]);

  const chosen = new Set(props.value.map((place) => place.id));
  const pick = (place: PickedPlace) => {
    if (!chosen.has(place.id)) props.onChange([...props.value, place]);
    setText("");
    setHits([]);
  };
  const create = async (make: () => Promise<PickedPlace>, what: string) => {
    setBusy(true);
    try {
      pick(await make());
      changed();
      toast(`Added the ${what}.`);
    } catch (failure) {
      toast(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const name = text.trim().replace(/^#/, "");
  const exact = hits.some((hit) => fold(hit.label) === fold(name));
  const servers = props.value.filter((place) => place.kind === "server");
  return (
    <div className="field picker">
      <span>{props.label}</span>
      {props.value.length ? (
        <div className="chips">
          {props.value.map((place) => (
            <span key={place.id} className="chip">
              {placeLabel(place)}
              <button
                type="button"
                aria-label={`Remove ${placeLabel(place)}`}
                onClick={() => props.onChange(props.value.filter((other) => other.id !== place.id))}
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
        placeholder="A server, #channel, or group chat"
        aria-label={props.label}
        onChange={(event) => setText(event.target.value)}
      />
      {hits.length || (name && !exact) ? (
        <div className="picker-hits">
          {hits
            .filter((hit) => !chosen.has(hit.id))
            .map((hit) => (
              <button key={hit.id} type="button" onClick={() => pick(hit)}>
                {placeLabel(hit)} <small>{hit.id.slice(0, 8)}</small>
              </button>
            ))}
          {name && !exact ? (
            <>
              {servers.map((server) => (
                <button
                  key={`channel-in-${server.id}`}
                  type="button"
                  className="create"
                  onClick={() =>
                    create(async () => {
                      const made = await createChannel(props.archiveId, server.id, name);
                      return { kind: "channel", ...made, detail: server.label };
                    }, `channel #${name}`)
                  }
                >
                  + New channel #{name} in {server.label}
                </button>
              ))}
              <button
                type="button"
                className="create"
                onClick={() =>
                  create(async () => {
                    const made = await createNamed(props.archiveId, "server", name);
                    return { kind: "server", ...made };
                  }, `server ${name}`)
                }
              >
                + New server “{name}”
              </button>
              <button
                type="button"
                className="create"
                onClick={() =>
                  create(async () => {
                    const made = await createNamed(props.archiveId, "group_chat", name);
                    return { kind: "channel", ...made, detail: "group chat" };
                  }, `group chat ${name}`)
                }
              >
                + New group chat “{name}”
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <span className="hint">
        The timeline shows the artifact in its server's or group chat's lane. Choose the server
        first to add a new channel in it.
      </span>
    </div>
  );
}
