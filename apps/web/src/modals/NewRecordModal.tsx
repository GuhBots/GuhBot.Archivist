import { useState } from "react";
import { api } from "../api.js";
import { characterPath, navigate, placePath } from "../router.js";
import { useWindows } from "../Shell.js";
import { useArchive } from "../state.js";
import { ErrorNote, Modal } from "../ui.js";

/**
 * Adds a character, server, or group chat by name and opens its page, where
 * the rest is filled in. A server's channels are added from its page.
 */
export function NewRecordModal(props: { kind: "character" | "server" | "group_chat" }) {
  const { archive, changed, toast } = useArchive();
  const windows = useWindows();
  const [name, setName] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const what = { character: "character", server: "server", group_chat: "group chat" }[props.kind];
  const submit = async () => {
    setBusy(true);
    setError(null);
    const base = `/api/archives/${archive.archiveId}/entities`;
    try {
      if (props.kind === "character") {
        const created = await api<{ id: string }>(`${base}/character`, {
          method: "POST",
          json: { knownName: name.trim() },
        });
        navigate(characterPath(archive.archiveId, created.id));
      } else {
        const created = await api<{ id: string }>(
          `${base}/${props.kind === "server" ? "server" : "channel"}`,
          {
            method: "POST",
            json:
              props.kind === "server"
                ? { label: name.trim() }
                : { kind: "group_chat", label: name.trim() },
          },
        );
        navigate(placePath(archive.archiveId, created.id));
      }
      changed();
      toast(`Added the ${what} ${name.trim()}.`);
      windows.close();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`New ${what}`}
      onClose={windows.close}
      footer={
        <>
          <button className="btn ghost" type="button" onClick={windows.close}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!name.trim() || busy}
            onClick={submit}
          >
            Add
          </button>
        </>
      }
    >
      <form
        className="content"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && !busy) void submit();
        }}
      >
        <label className="field">
          <span>
            {props.kind === "character"
              ? "Known name, as the group calls them"
              : props.kind === "server"
                ? "Server name"
                : "Group chat name"}
          </span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <p className="hint" style={{ margin: 0 }}>
          {props.kind === "character"
            ? "Its page opens next, for accounts, pictures, and dated history."
            : "Its page opens next. Edit Place adds dated names, icons, a lane color, and channels."}
        </p>
        <ErrorNote error={error} />
      </form>
    </Modal>
  );
}
