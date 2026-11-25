import { useEffect, useState } from "react";
import { api, type CharacterView, type MergePreview } from "../api.js";
import { type Picked, Picker } from "../components/Picker.js";
import { dayText } from "../format.js";
import { useWindows } from "../Shell.js";
import { useArchive } from "../state.js";
import { ErrorNote, Modal } from "../ui.js";

type Field = MergePreview["conflicts"][number]["field"];

const FIELD_LABELS: Record<Field, string> = {
  knownName: "Known name",
  realName: "Real name",
  birthDay: "Birth date",
  metInPerson: "Met in person",
  fallbackPicture: "Fallback picture",
};

function shown(field: Field, value: string): string {
  if (field === "birthDay") return dayText(value);
  if (field === "fallbackPicture") return "their fallback picture";
  return value;
}

/**
 * Merges another character into this one, for when the same character was
 * added twice. The contributor reviews every difference and chooses which
 * value to keep. The other record's known name becomes an alias.
 */
export function CharacterMergeModal(props: { survivor: CharacterView }) {
  const { archive, changed, toast } = useArchive();
  const windows = useWindows();
  const [other, setOther] = useState<Picked[]>([]);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [choices, setChoices] = useState<Partial<Record<Field, "survivor" | "merged">>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/archives/${archive.archiveId}/entities/character/merge`;
  const mergedId = other.find((o) => o.id !== props.survivor.id)?.id ?? null;

  useEffect(() => {
    setPreview(null);
    setChoices({});
    setError(null);
    if (!mergedId) return;
    api<MergePreview>(`${base}/preview`, {
      method: "POST",
      json: { survivorId: props.survivor.id, mergedId },
    })
      .then(setPreview)
      .catch(setError);
  }, [base, mergedId, props.survivor.id]);

  const ready = preview && preview.conflicts.every((conflict) => choices[conflict.field]);
  const merge = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await api(base, {
        method: "POST",
        json: {
          survivorId: preview.survivor.id,
          survivorVersion: preview.survivor.version,
          mergedId: preview.merged.id,
          mergedVersion: preview.merged.version,
          choices,
        },
      });
      changed();
      toast(`Merged ${preview.merged.knownName} into ${preview.survivor.knownName}.`);
      windows.close();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const moves = preview ? Object.entries(preview.moves) : [];
  return (
    <Modal
      title={`Merge into ${props.survivor.knownName}`}
      wide
      onClose={windows.close}
      footer={
        <>
          <button className="btn ghost" type="button" onClick={windows.close}>
            Cancel
          </button>
          <button className="btn primary" type="button" disabled={!ready || busy} onClick={merge}>
            Merge
          </button>
        </>
      }
    >
      <div className="content">
        <Picker
          archiveId={archive.archiveId}
          kind="character"
          label={`The duplicate of ${props.survivor.knownName}`}
          value={other}
          onChange={(value) => setOther(value.filter((v) => v.id !== props.survivor.id).slice(-1))}
        />
        {preview ? (
          <>
            {preview.conflicts.length ? (
              <>
                <p className="hint" style={{ margin: 0 }}>
                  Choose which value to keep where the two differ.
                </p>
                {preview.conflicts.map((conflict) => (
                  <div key={conflict.field} className="field">
                    <span>{FIELD_LABELS[conflict.field]}</span>
                    <div className="radio-list" role="radiogroup">
                      {(["survivor", "merged"] as const).map((side) => (
                        <label key={side}>
                          <input
                            type="radio"
                            name={conflict.field}
                            checked={choices[conflict.field] === side}
                            onChange={() => setChoices({ ...choices, [conflict.field]: side })}
                          />
                          <span>
                            {shown(conflict.field, conflict[side])}
                            <small>
                              from{" "}
                              {side === "survivor"
                                ? preview.survivor.knownName
                                : preview.merged.knownName}
                            </small>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <p className="hint" style={{ margin: 0 }}>
                No values conflict.
              </p>
            )}
            <p className="hint" style={{ margin: 0 }}>
              {moves.length
                ? `Moves to ${preview.survivor.knownName}: ${moves.map(([what, n]) => `${n} ${what}`).join(", ")}. `
                : ""}
              Links both records share are kept once. The known name that is not kept becomes an
              alias, and {preview.merged.knownName}'s record is removed.
            </p>
          </>
        ) : null}
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
