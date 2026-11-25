import { useEffect, useState } from "react";
import {
  api,
  type ArtifactDetails,
  type ArtifactPage,
  type ArtifactSummary,
  query,
} from "../api.js";
import { dayText, shortId } from "../format.js";
import { useSettled } from "../Shell.js";
import { Thumb } from "./Media.js";

export interface ChosenArtifact {
  id: string;
  description: string;
}

type Hit = Pick<ArtifactSummary, "id" | "description" | "day" | "media">;

/** A looked-up artifact in the same shape as a search match. */
function hitOf(artifact: ArtifactDetails): Hit {
  const { media } = artifact;
  const kind = media.mimeType.startsWith("video/")
    ? "video"
    : media.mimeType.startsWith("audio/")
      ? "audio"
      : "image";
  return {
    id: artifact.id,
    description: artifact.description,
    day: artifact.dates.selected?.date.archiveDay ?? null,
    media: { ...media, kind, filename: media.originalFilename },
  };
}

/** An artifact's ID typed or pasted, full or short, as the Discord replies show it. */
const ID_LIKE = /^[0-9a-f]{8}(?:-[0-9a-f-]{0,28})?$/i;

/**
 * Chooses one artifact by typing part of its description or its ID. The
 * matches show their picture, date, and short ID.
 */
export function ArtifactChooser(props: {
  archiveId: string;
  label: string;
  value: ChosenArtifact | null;
  onChange(value: ChosenArtifact | null): void;
  /** Leaves undated artifacts out, such as for date research. */
  datedOnly?: boolean;
}) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const typed = useSettled(text.trim(), 200);
  const { archiveId, datedOnly } = props;
  useEffect(() => {
    if (!typed) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    const signal = controller.signal;
    (async () => {
      const page = await api<ArtifactPage>(
        `/api/archives/${archiveId}/artifacts${query({ q: typed, limit: 8 })}`,
        { signal },
      );
      const found: Hit[] = page.items;
      if (ID_LIKE.test(typed)) {
        const byId = await api<ArtifactDetails>(
          `/api/archives/${archiveId}/artifacts/${encodeURIComponent(typed)}`,
          { signal },
        ).catch(() => null);
        if (byId && !found.some((item) => item.id === byId.id)) found.unshift(hitOf(byId));
      }
      setHits(datedOnly ? found.filter((item) => item.day) : found);
    })().catch(() => undefined);
    return () => controller.abort();
  }, [typed, archiveId, datedOnly]);

  if (props.value) {
    return (
      <div className="field">
        <span>{props.label}</span>
        <div className="chips">
          <span className="chip">
            {shortId(props.value.id)} {props.value.description.slice(0, 60)}
            <button type="button" aria-label="Choose another" onClick={() => props.onChange(null)}>
              ×
            </button>
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="field picker">
      <span>{props.label}</span>
      <input
        value={text}
        placeholder="Type part of its description, or its ID"
        aria-label={props.label}
        onChange={(event) => setText(event.target.value)}
      />
      {typed && !hits.length ? <span className="hint">Nothing matches yet.</span> : null}
      {hits.length ? (
        <div className="picker-hits artifact-hits">
          {hits.map((hit) => (
            <button
              key={hit.id}
              type="button"
              onClick={() => {
                props.onChange({ id: hit.id, description: hit.description });
                setText("");
              }}
            >
              <span className="thumb">
                <Thumb archiveId={props.archiveId} media={hit.media} />
              </span>
              <span>
                {hit.description}
                <small>
                  {dayText(hit.day)} · {shortId(hit.id)}
                </small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
