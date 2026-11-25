import { useEffect, useRef, useState } from "react";
import { byteText } from "../format.js";

/**
 * What the archive accepts, for file pickers. The extensions are listed as
 * well as the types, because some systems type an Ogg file, such as a
 * Discord voice message, as `application/ogg`, which `audio/*` does not
 * match. The server checks each file's real format either way.
 */
export const MEDIA_ACCEPT = [
  "image/*",
  "video/*",
  "audio/*",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".mp3",
  ".m4a",
  ".wav",
  ".ogg",
  ".oga",
  ".opus",
  ".flac",
].join(",");

export const IMAGE_ACCEPT = "image/*,.jpg,.jpeg,.png,.webp,.gif";

/** Whether a file matches an `accept` list of types, wildcard types, and extensions. */
export function accepts(accept: string, file: { name: string; type: string }): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .some((token) =>
      token.startsWith(".")
        ? name.endsWith(token)
        : token.endsWith("/*")
          ? type.startsWith(token.slice(0, -1))
          : type === token,
    );
}

/**
 * A dashed box to drop a file on, or to click to choose one. The chosen
 * file's name shows on its own line below the prompt.
 */
export function FileDrop(props: {
  label: string;
  accept: string;
  file: File | null;
  onFile(file: File | null): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // A form that clears its file after saving also clears the input, so the same file can be chosen again.
  useEffect(() => {
    if (!props.file && input.current) input.current.value = "";
  }, [props.file]);
  const take = (file: File | null) => {
    if (file && !accepts(props.accept, file)) {
      setRefused(file.name);
      return;
    }
    setRefused(null);
    props.onFile(file);
  };
  const clear = () => {
    setRefused(null);
    props.onFile(null);
  };
  return (
    <div className="field">
      <span>{props.label}</span>
      <label
        className={`drop${over ? " over" : ""}${props.file ? " chosen" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          take(event.dataTransfer.files[0] ?? null);
        }}
      >
        <input
          ref={input}
          className="visually-hidden"
          type="file"
          accept={props.accept}
          aria-label={props.label}
          onChange={(event) => take(event.target.files?.[0] ?? null)}
        />
        <span className="drop-prompt">
          <span className="drop-choose">Choose a file</span> or drop one here
        </span>
        <span className="drop-file">
          {props.file ? `${props.file.name} · ${byteText(props.file.size)}` : "No file chosen"}
        </span>
      </label>
      {refused ? (
        <span className="error-note" role="alert">
          {refused} is not a file this accepts.
        </span>
      ) : null}
      {props.file ? (
        <button className="btn ghost small" type="button" onClick={clear}>
          Remove the file
        </button>
      ) : null}
    </div>
  );
}
