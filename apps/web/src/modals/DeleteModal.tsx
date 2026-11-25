import { useState } from "react";
import { api } from "../api.js";
import { useWindows } from "../Shell.js";
import { useArchive } from "../state.js";
import { ErrorNote, Modal } from "../ui.js";

/**
 * Confirms permanently deleting a character, account, server, channel, or
 * group chat, as artifacts are confirmed. The service refuses again if
 * something linked to the record since the page loaded.
 */
export function DeleteModal(props: {
  /** What is deleted, such as `the character Sam`. */
  what: string;
  /** The record's address under the archive, such as `/entities/character/<id>`. */
  path: string;
  version: number;
  onDeleted(): void;
  /** Where "Keep it" goes, such as back to the window that asked. It closes by default. */
  onKeep?(): void;
}) {
  const { archive, toast, changed } = useArchive();
  const windows = useWindows();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`Delete ${props.what}?`}
      onClose={windows.close}
      footer={
        <>
          <button className="btn ghost" type="button" onClick={props.onKeep ?? windows.close}>
            Keep it
          </button>
          <button
            className="btn danger"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api(
                  `/api/archives/${archive.archiveId}${props.path}?expectedVersion=${props.version}`,
                  { method: "DELETE" },
                );
                toast("Deleted.");
                windows.close();
                changed();
                props.onDeleted();
              } catch (failure) {
                setError(failure);
              } finally {
                setBusy(false);
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
          This is permanent. There is no trash or undo. Its own dated history and edit history go
          with it. Nothing links to it any more, so no artifact or event changes.
        </p>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
