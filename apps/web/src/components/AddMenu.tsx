import { useEffect, useRef, useState } from "react";
import { AddArtifactModal } from "../modals/AddArtifactModal.js";
import { EventFormModal } from "../modals/EventModal.js";
import { NewRecordModal } from "../modals/NewRecordModal.js";
import { RequestModal } from "../modals/RequestModal.js";
import { useWindows } from "../Shell.js";
import type { Picked } from "./Picker.js";
import type { PickedPlace } from "./PlacePicker.js";

/**
 * The one add button every view's tray has: a round plus that opens a menu
 * of everything that can be added. A view can fill in what it already
 * knows, such as the character or place it shows.
 */
export function AddMenu(props: { characters?: Picked[]; places?: PickedPlace[] }) {
  const windows = useWindows();
  // Fixed coordinates, because the tray scrolls sideways and would clip a menu inside it.
  const [open, setOpen] = useState<{ left: number; bottom: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const items: [string, () => void][] = [
    [
      "Artifact",
      () => windows.show(<AddArtifactModal characters={props.characters} places={props.places} />),
    ],
    ["Event", () => windows.show(<EventFormModal />)],
    ["Character", () => windows.show(<NewRecordModal kind="character" />)],
    ["Server", () => windows.show(<NewRecordModal kind="server" />)],
    ["Group chat", () => windows.show(<NewRecordModal kind="group_chat" />)],
    ["Missing-media request", () => windows.show(<RequestModal characters={props.characters} />)],
  ];
  return (
    <div ref={box} className="add-menu">
      <button
        ref={button}
        className="add-btn"
        type="button"
        aria-label="Add"
        title="Add an artifact, event, character, place, or request"
        aria-haspopup="menu"
        aria-expanded={Boolean(open)}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setOpen(
            open
              ? null
              : {
                  left: Math.max(8, Math.min(rect.left, window.innerWidth - 240)),
                  bottom: window.innerHeight - rect.top + 8,
                },
          );
        }}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M8 2.5v11M2.5 8h11" />
        </svg>
      </button>
      {open ? (
        <div
          className="popover add-popover"
          role="menu"
          aria-label="Add"
          style={{ left: open.left, bottom: open.bottom }}
        >
          {items.map(([label, action]) => (
            <button
              key={label}
              className="btn ghost"
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(null);
                // The window returns focus to whatever had it, and this menu item is about to go.
                button.current?.focus();
                action();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
