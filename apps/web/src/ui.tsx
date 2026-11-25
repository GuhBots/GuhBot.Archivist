import { type ReactNode, useEffect, useRef } from "react";
import { mediaUrl, type Picture } from "./api.js";
import { initials } from "./format.js";

/**
 * A dialog over the page. Escape and the backdrop close it, and focus
 * returns where it was. Only the body scrolls, so the footer, which holds
 * Save, is always in view.
 */
export function Modal(props: {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  children: ReactNode;
  onKey?: (event: KeyboardEvent) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The handlers can change while the window stays open, such as when an
  // album steps to the next artifact. Reading them through a ref keeps focus
  // where it is instead of moving it back to the first control.
  const handlers = useRef({ onClose: props.onClose, onKey: props.onKey });
  handlers.current = { onClose: props.onClose, onKey: props.onKey };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>(
      "input, select, textarea, button:not(.icon-btn):not([disabled])",
    );
    first?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") handlers.current.onClose();
      else handlers.current.onKey?.(event);
    };
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      previous?.focus?.();
    };
  }, []);
  const { onClose } = props;
  return (
    <div
      className="backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={box}
        className={`modal ${props.wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <header>
          <h2>{props.title}</h2>
          <button className="icon-btn" type="button" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer ? <footer>{props.footer}</footer> : <span />}
      </div>
    </div>
  );
}

/**
 * A character's or place's picture, with initials when none is known. A
 * fallback picture carries an F, and a stand-in, a picture not known for the
 * date shown, carries a ~, so neither passes for verified history.
 */
export function Avatar(props: {
  archiveId: string;
  picture: Picture | { mediaId: string | null; standIn?: boolean } | null;
  name: string;
  size?: "xs" | "sm" | "lg" | "xl";
  color?: string;
}) {
  const mediaId = props.picture && "mediaId" in props.picture ? props.picture.mediaId : null;
  const fallback =
    props.picture && "source" in props.picture && props.picture.source === "fallback";
  const standIn = Boolean(props.picture && "standIn" in props.picture && props.picture.standIn);
  if (!mediaId) {
    return (
      <span
        className={`av ${props.size ?? ""} ${props.color ? "" : "initials"}`}
        style={props.color ? { background: props.color } : undefined}
        aria-hidden="true"
      >
        {initials(props.name)}
      </span>
    );
  }
  // Originals, so an animated GIF avatar plays as it was uploaded.
  return (
    <span
      className={`av ${props.size ?? ""} ${fallback ? "fallback" : standIn ? "standin" : ""}`}
      aria-hidden="true"
      title={
        fallback
          ? "Fallback picture, not from an account"
          : standIn
            ? "Latest known picture. None is recorded for this date."
            : undefined
      }
    >
      <img src={mediaUrl(props.archiveId, mediaId)} alt="" loading="lazy" />
    </span>
  );
}

export function Toast(props: { text: string | null }) {
  if (!props.text) return null;
  return (
    <div className="toast" role="status">
      {props.text}
    </div>
  );
}

/** An error under a form. It scrolls itself into view, so a failed Save is never silent. */
export function ErrorNote(props: { error: unknown }) {
  const note = useRef<HTMLParagraphElement>(null);
  const message = !props.error
    ? null
    : props.error instanceof Error
      ? props.error.message
      : String(props.error);
  useEffect(() => {
    if (message) note.current?.scrollIntoView?.({ block: "nearest" });
  }, [message, props.error]);
  if (!message) return null;
  return (
    <p ref={note} className="error-note" role="alert">
      {message}
    </p>
  );
}
