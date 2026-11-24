import { useEffect, useMemo, useState } from "react";
import { api, type CharacterSummary, query } from "../api.js";

/**
 * Every character's summary by ID, with their latest picture, fetched once
 * per archive and change. Rows that list who is in an artifact use the
 * names, and the board and graph also use the pictures.
 */
const cache = new Map<string, Promise<Record<string, CharacterSummary>>>();

export function useCharacters(
  archiveId: string,
  revision: number,
): Record<string, CharacterSummary> {
  const [characters, setCharacters] = useState<Record<string, CharacterSummary>>({});
  useEffect(() => {
    const key = `${archiveId}:${revision}`;
    let load = cache.get(key);
    if (!load) {
      for (const cachedKey of cache.keys()) {
        if (cachedKey.startsWith(`${archiveId}:`)) cache.delete(cachedKey);
      }
      load = (async () => {
        const all: Record<string, CharacterSummary> = {};
        let cursor: string | null = null;
        do {
          const page: { items: CharacterSummary[]; next: string | null } = await api(
            `/api/archives/${archiveId}/entities/character${query({ limit: 100, cursor })}`,
          );
          for (const item of page.items) all[item.id] = item;
          cursor = page.next;
        } while (cursor);
        return all;
      })();
      cache.set(key, load);
    }
    let live = true;
    load.then((result) => live && setCharacters(result)).catch(() => cache.delete(key));
    return () => {
      live = false;
    };
  }, [archiveId, revision]);
  return characters;
}

/** Every character's known name by ID. */
export function useCharacterNames(archiveId: string, revision: number): Record<string, string> {
  const characters = useCharacters(archiveId, revision);
  return useMemo(
    () => Object.fromEntries(Object.values(characters).map((c) => [c.id, c.knownName])),
    [characters],
  );
}
