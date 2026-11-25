import { characterPath, navigate } from "../router.js";
import { useWindows } from "../Shell.js";
import { useArchive } from "../state.js";
import { Avatar } from "../ui.js";
import { useCharacters } from "./use-names.js";

/**
 * The characters linked to an artifact or event, as chips with each one's
 * latest picture. A chip opens that character's page.
 */
export function CharacterChips(props: {
  ids: string[];
  names: Record<string, string>;
  empty: string;
}) {
  const { archive, revision } = useArchive();
  const windows = useWindows();
  const characters = useCharacters(archive.archiveId, revision);
  if (!props.ids.length) return <>{props.empty}</>;
  return (
    <span className="chips">
      {props.ids.map((id) => {
        const name = characters[id]?.knownName ?? props.names[id] ?? id.slice(0, 8);
        return (
          <button
            key={id}
            className="chip person"
            type="button"
            title={`Open ${name}'s page`}
            onClick={() => {
              windows.close();
              navigate(characterPath(archive.archiveId, id));
            }}
          >
            <Avatar
              archiveId={archive.archiveId}
              picture={characters[id]?.picture ?? null}
              name={name}
              size="xs"
            />
            {name}
          </button>
        );
      })}
    </span>
  );
}
