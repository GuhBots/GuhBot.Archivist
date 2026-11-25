import { useCallback, useState } from "react";
import { type CharacterView, mediaUrl } from "../api.js";
import { dayText } from "../format.js";
import { useWindows } from "../Shell.js";
import { useArchive } from "../state.js";
import { Modal } from "../ui.js";

/**
 * Every picture a character has had, oldest first: each account avatar with
 * its account and start date, then the fallback picture. Originals are
 * shown, so animated GIFs play as they were uploaded.
 */
export function PicturesModal(props: { character: CharacterView; start?: number }) {
  const { archive } = useArchive();
  const windows = useWindows();
  const { character } = props;
  const list = character.pictures;
  const [index, setIndex] = useState(Math.min(props.start ?? 0, list.length - 1));
  const step = useCallback(
    (by: number) => setIndex((current) => Math.min(list.length - 1, Math.max(0, current + by))),
    [list.length],
  );
  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "ArrowRight") step(1);
    },
    [step],
  );
  const picture = list[index];
  if (!picture) return null;
  const account = character.accounts.find((a) => a.id === picture.accountId);
  return (
    <Modal
      title={`${character.knownName}'s pictures · ${index + 1} of ${list.length}`}
      wide
      onClose={windows.close}
      onKey={onKey}
      footer={
        <>
          <button className="btn" type="button" disabled={index === 0} onClick={() => step(-1)}>
            Previous
          </button>
          <button
            className="btn"
            type="button"
            disabled={index === list.length - 1}
            onClick={() => step(1)}
          >
            Next
          </button>
        </>
      }
    >
      <div className="content">
        <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          <span className={`av xl ${picture.accountId ? "" : "fallback"}`}>
            <img src={mediaUrl(archive.archiveId, picture.mediaId)} alt="" />
          </span>
          <dl className="kv" style={{ flex: 1, minWidth: 200 }}>
            <dt>From</dt>
            <dd>
              {picture.date
                ? dayText(picture.date.archiveDay)
                : picture.accountId
                  ? "Date unknown"
                  : "No date. Used when no account picture is known."}
            </dd>
            <dt>Account</dt>
            <dd>
              {account ? account.label : picture.accountId ? "An account" : "Fallback picture"}
            </dd>
          </dl>
        </div>
        <div className="pic-strip" role="list">
          {list.map((item, i) => (
            <button
              key={`${item.mediaId}:${i}`}
              type="button"
              aria-current={i === index ? "true" : undefined}
              aria-label={
                item.date ? `Picture from ${dayText(item.date.archiveDay)}` : "Undated picture"
              }
              onClick={() => setIndex(i)}
            >
              <span className="av">
                <img src={mediaUrl(archive.archiveId, item.mediaId)} alt="" loading="lazy" />
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
