import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type ArtifactPage,
  type CharacterView,
  type EntityView,
  type EventPage,
  type HistoryEntry,
  query,
} from "../api.js";
import { DateField } from "../components/DateField.js";
import { FileDrop, IMAGE_ACCEPT } from "../components/FileDrop.js";
import { blockersText, type HistoryChange, HistoryRows } from "../components/History.js";
import { Thumb } from "../components/Media.js";
import { type Picked, Picker } from "../components/Picker.js";
import { byteText, dayText, todayDay } from "../format.js";
import { AccountModal, fetchDiscordAvatar } from "../modals/AccountModal.js";
import { CharacterMergeModal } from "../modals/CharacterMergeModal.js";
import { DeleteModal } from "../modals/DeleteModal.js";
import { PicturesModal } from "../modals/PicturesModal.js";
import { characterPath, navigate, viewPath } from "../router.js";
import { useWindows } from "../Shell.js";
import { EMPTY_FILTERS, useArchive } from "../state.js";
import { Avatar, ErrorNote } from "../ui.js";
import { AddMenu } from "../components/AddMenu.js";
import { ViewFrame } from "./ViewFrame.js";

/**
 * A character's page: their known name, facts, aliases, main accounts,
 * accounts, introductions, and their artifacts and events. Each account
 * opens in its own window. Dated history is edited here rather than in
 * Discord. Each change saves at once with the version just loaded, so
 * nothing overwrites someone else's edit.
 */

const ARTIFACTS_SHOWN = 24;

/** Whole years from a birth day to today. */
function ageOn(birthDay: string, today: string): number {
  const [by, bm, bd] = birthDay.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** Where the character's picture comes from, in words. */
function pictureNote(character: CharacterView): string {
  const picture = character.picture;
  if (picture.source === "fallback") return "a fallback picture, not from an account";
  if (picture.source === "initials") return "none known yet";
  const account = character.accounts.find((a) => a.id === picture.accountId);
  const name = account?.name ?? "an account";
  return picture.standIn
    ? `the latest known avatar of ${name}. Name a main account to use its avatar.`
    : `the avatar of their main account, ${name}`;
}

export function CharacterPage(props: { id: string }) {
  const { archive, revision, changed, toast, setFilters } = useArchive();
  const windows = useWindows();
  const [character, setCharacter] = useState<CharacterView | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactPage | null>(null);
  const [events, setEvents] = useState<EventPage | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const base = `/api/archives/${archive.archiveId}`;
  const url = `${base}/entities/character/${props.id}`;

  const load = useCallback(async () => {
    const [record, artifactPage, eventPage] = await Promise.all([
      api<CharacterView>(url),
      api<ArtifactPage>(
        `${base}/artifacts${query({ character: props.id, sort: "oldest", limit: ARTIFACTS_SHOWN })}`,
      ),
      api<EventPage>(`${base}/events${query({ character: props.id, limit: 100 })}`),
    ]);
    setCharacter(record);
    setArtifacts(artifactPage);
    setEvents(eventPage);
  }, [base, url, props.id]);

  useEffect(() => {
    setError(null);
    load().catch(setError);
  }, [load, revision]);
  useEffect(() => setEditing(false), [props.id]);

  /** Saves a change, then reloads. A stale version reloads too and says why. */
  const run = useCallback(
    async (action: () => Promise<unknown>, done: string | (() => string)): Promise<boolean> => {
      setError(null);
      try {
        await action();
        changed();
        toast(typeof done === "function" ? done() : done);
        return true;
      } catch (failure) {
        if (failure instanceof ApiError && failure.code === "stale_version") {
          changed();
          setError(
            new Error(
              "Someone else changed this character. Their current values are shown; try again.",
            ),
          );
        } else setError(failure);
        return false;
      }
    },
    [changed, toast],
  );

  if (!character) {
    return (
      <ViewFrame label="Character" head={<h1>Character</h1>}>
        {error ? <ErrorNote error={error} /> : <div className="empty">Loading…</div>}
      </ViewFrame>
    );
  }

  const name = character.knownName;
  const history = (kind: HistoryEntry["kind"]) =>
    character.history.filter((entry) => entry.kind === kind);
  const removeEntry = (parent: string, version: number, entry: HistoryEntry, done: string) =>
    run(
      () =>
        api(
          `${base}/entities/${parent}/history/${entry.id}${query({
            historyKind: entry.kind,
            expectedVersion: version,
          })}`,
          { method: "DELETE" },
        ),
      done,
    );
  const addEntry = (parent: string, version: number, json: Record<string, unknown>, done: string) =>
    run(
      () =>
        api(`${base}/entities/${parent}/history`, {
          method: "POST",
          json: { ...json, expectedVersion: version },
        }),
      done,
    );
  const editEntry = (parent: string, version: number, entry: HistoryEntry, change: HistoryChange) =>
    run(
      () =>
        api(`${base}/entities/${parent}/history/${entry.id}`, {
          method: "PATCH",
          json: { historyKind: entry.kind, expectedVersion: version, ...change },
        }),
      "Saved.",
    );
  // Introductions this character made belong to the introduced character's history.
  const introducedRows: (HistoryEntry & { parentVersion: number })[] = character.introduced.map(
    (intro) => ({
      kind: "introduction",
      id: intro.entryId,
      name: null,
      discriminator: null,
      targetId: intro.characterId,
      targetName: intro.knownName,
      mediaId: null,
      date: intro.date,
      start: null,
      end: null,
      parentVersion: intro.characterVersion,
    }),
  );
  const mainAccountId =
    character.history
      .filter((entry) => entry.kind === "main_account" && entry.date)
      .sort((a, b) => b.date!.archiveDay.localeCompare(a.date!.archiveDay))[0]?.targetId ??
    character.history.find((entry) => entry.kind === "main_account")?.targetId;
  const blocked = Object.keys(character.blockers).length > 0;
  const own = `character/${character.id}`;
  const artifactIds = artifacts?.items.map((item) => item.id) ?? [];

  return (
    <ViewFrame
      label="Character"
      tray={
        <>
          <AddMenu characters={[{ id: character.id, label: name }]} />
          <span className="sep" />
          <button className="btn" type="button" onClick={() => window.history.back()}>
            Back
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setFilters({ ...EMPTY_FILTERS, characters: [character.id] });
              navigate(viewPath(archive.archiveId, "timeline"));
            }}
          >
            Show {name} on the timeline
          </button>
          <button
            className="btn"
            type="button"
            onClick={() =>
              navigate(`${viewPath(archive.archiveId, "graph")}${query({ focus: character.id })}`)
            }
          >
            Graph around {name}
          </button>
          <span className="sep" />
          <button
            className={`btn ${editing ? "" : "primary"}`}
            type="button"
            aria-pressed={editing}
            onClick={() => setEditing(!editing)}
          >
            {editing ? "Done editing" : "Edit history"}
          </button>
          <span className="hint">Dated history is edited here, not in Discord.</span>
        </>
      }
    >
      <div className="char">
        <div className="char-head">
          {character.pictures.length ? (
            <button
              className="pic-btn"
              type="button"
              aria-label={`${name}'s pictures over time`}
              title="See every picture over time"
              onClick={() => windows.show(<PicturesModal character={character} />)}
            >
              <Avatar
                archiveId={archive.archiveId}
                picture={character.picture}
                name={name}
                size="lg"
              />
            </button>
          ) : (
            <Avatar archiveId={archive.archiveId} picture={null} name={name} size="lg" />
          )}
          <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
            <h1>{name}</h1>
            <div className="facts">
              <span>
                <b>Real name:</b> {character.realName ?? "unknown"}
              </span>
              <span>
                <b>Birth date:</b>{" "}
                {character.birthDay
                  ? `${dayText(character.birthDay)} (age ${ageOn(character.birthDay, todayDay())})`
                  : "unknown"}
              </span>
              <span>
                <b>Met in person:</b> {character.metInPerson}
              </span>
            </div>
            <span className="hint pic-note">
              <b>Picture:</b> {pictureNote(character)}
              {character.pictures.length > 1
                ? `. Select it to see all ${character.pictures.length}.`
                : ""}
            </span>
          </div>
        </div>
        <ErrorNote error={error} />

        {editing ? <FactsForm character={character} run={run} url={url} /> : null}

        <div className="sections">
          <Box title="Aliases">
            <HistoryRows
              entries={history("alias")}
              editing={editing}
              render={(entry) => entry.name}
              onRemove={(entry) => removeEntry(own, character.version, entry, "Removed the alias.")}
              onEdit={(entry, change) => editEntry(own, character.version, entry, change)}
            />
            {editing ? (
              <AddRow
                fields={[{ key: "name", label: "Alias" }]}
                dateLabel="Seen on (optional)"
                onAdd={(values) =>
                  addEntry(
                    own,
                    character.version,
                    { kind: "alias", name: values.name, date: values.date },
                    "Added the alias.",
                  )
                }
              />
            ) : null}
          </Box>

          <Box title="Main account">
            <HistoryRows
              entries={history("main_account")}
              editing={editing}
              render={(entry) => `${entry.targetName ?? "An account"} from this date`}
              onRemove={(entry) =>
                removeEntry(own, character.version, entry, "Removed the main account.")
              }
              onEdit={(entry, change) => editEntry(own, character.version, entry, change)}
            />
            {editing && character.accounts.length ? (
              <AddRow
                fields={[
                  {
                    key: "account",
                    label: "Account",
                    options: character.accounts.map((a) => [a.id, a.label]),
                  },
                ]}
                dateLabel="From (optional)"
                onAdd={(values) =>
                  addEntry(
                    own,
                    character.version,
                    { kind: "main_account", targetId: values.account, date: values.date },
                    "Added the main account.",
                  )
                }
              />
            ) : null}
            {editing && !character.accounts.length ? (
              <span className="hint">Link an account below first.</span>
            ) : null}
          </Box>

          <Box title={`Accounts (${character.accounts.length})`}>
            {character.accounts.length ? (
              <div className="account-list">
                {character.accounts.map((account) => (
                  <button
                    key={account.id}
                    className="account-row"
                    type="button"
                    onClick={() => windows.show(<AccountModal accountId={account.id} />)}
                  >
                    <Avatar
                      archiveId={archive.archiveId}
                      picture={{ mediaId: account.avatarMediaId }}
                      name={account.name}
                      size="sm"
                    />
                    <span className="nm">{account.name}</span>
                    <span className="hint">
                      {[
                        account.id === mainAccountId ? "main" : null,
                        account.accountKind === "bot" ? "bot" : null,
                        account.discordCreatedAt
                          ? `since ${dayText(account.discordCreatedAt.slice(0, 10))}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <span className="hint">No accounts linked yet.</span>
            )}
            {editing ? <AccountsForm character={character} run={run} /> : null}
          </Box>

          <Box title="Introductions">
            <HistoryRows
              entries={history("introduction")}
              editing={editing}
              empty={
                introducedRows.length ? "Nobody introduced them, as far as is known." : undefined
              }
              render={(entry) => (
                <>
                  Introduced by{" "}
                  <CharacterLink id={entry.targetId} name={entry.targetName ?? "someone"} />
                </>
              )}
              onRemove={(entry) =>
                removeEntry(own, character.version, entry, "Removed the introduction.")
              }
              onEdit={(entry, change) => editEntry(own, character.version, entry, change)}
            />
            {introducedRows.length ? (
              <HistoryRows
                entries={introducedRows}
                editing={editing}
                render={(entry) => (
                  <>
                    Introduced <CharacterLink id={entry.targetId} name={entry.targetName ?? ""} />
                  </>
                )}
                onRemove={(entry) =>
                  removeEntry(
                    `character/${entry.targetId}`,
                    (entry as (typeof introducedRows)[number]).parentVersion,
                    entry,
                    "Removed the introduction.",
                  )
                }
                onEdit={(entry, change) =>
                  editEntry(
                    `character/${entry.targetId}`,
                    (entry as (typeof introducedRows)[number]).parentVersion,
                    entry,
                    change,
                  )
                }
              />
            ) : null}
            {editing ? (
              <IntroducedByForm
                characterId={character.id}
                onAdd={(introducer, date) =>
                  addEntry(
                    own,
                    character.version,
                    { kind: "introduction", targetId: introducer, date },
                    "Added the introduction.",
                  )
                }
              />
            ) : null}
          </Box>
        </div>

        {editing ? (
          <div className="sections">
            <FallbackPictureForm character={character} run={run} url={url} />
            <section className="box">
              <h2>Merge with another character</h2>
              <span className="hint">
                For when the same character was added twice. You choose which values survive and
                review conflicts. Names never merge automatically.
              </span>
              <div>
                <button
                  className="btn"
                  type="button"
                  onClick={() => windows.show(<CharacterMergeModal survivor={character} />)}
                >
                  Review a merge…
                </button>
              </div>
            </section>
            <section className="box">
              <h2>Delete this character</h2>
              {blocked ? (
                <span className="hint">
                  Still linked from {blockersText(character.blockers)}. Remove those links first, so
                  nothing is deleted by accident. Unlink or delete their accounts from each
                  account's window.
                </span>
              ) : (
                <span className="hint">
                  Nothing links to them any more, so they can be deleted.
                </span>
              )}
              <div>
                <button
                  className="btn danger"
                  type="button"
                  disabled={blocked}
                  onClick={() =>
                    windows.show(
                      <DeleteModal
                        what={`the character ${name}`}
                        path={`/entities/character/${character.id}`}
                        version={character.version}
                        onDeleted={() => navigate(viewPath(archive.archiveId, "timeline"))}
                      />,
                    )
                  }
                >
                  Delete character…
                </button>
              </div>
            </section>
          </div>
        ) : null}

        <section className="box">
          <h2>Artifacts ({artifacts?.total ?? 0})</h2>
          {artifacts?.items.length ? (
            <div className="thumbs">
              {artifacts.items.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  title={`${item.description} · ${byteText(item.media.byteLength)}`}
                  aria-label={`${item.description}, ${dayText(item.day)}`}
                  onClick={() =>
                    windows.openArtifact(item.id, { ids: artifactIds, index, title: name })
                  }
                >
                  <Thumb archiveId={archive.archiveId} media={item.media} />
                </button>
              ))}
            </div>
          ) : (
            <span className="hint">Nothing recorded.</span>
          )}
          {artifacts && artifacts.total > artifacts.items.length ? (
            <button
              className="linkish"
              type="button"
              style={{ justifySelf: "start" }}
              onClick={() => {
                setFilters({ ...EMPTY_FILTERS, characters: [character.id] });
                navigate(viewPath(archive.archiveId, "album"));
              }}
            >
              See all {artifacts.total} in the album
            </button>
          ) : null}
        </section>

        <section className="box">
          <h2>Events ({events?.total ?? 0})</h2>
          {events?.items.length ? (
            <div className="hist">
              {events.items.map((event) => (
                <div key={event.id}>
                  <time>{dayText(event.start.archiveDay)}</time>
                  <button
                    className="linkish"
                    style={{ textAlign: "left" }}
                    type="button"
                    onClick={() => windows.openEvent(event.id)}
                  >
                    {event.title}
                  </button>
                  <span />
                </div>
              ))}
            </div>
          ) : (
            <span className="hint">Nothing recorded.</span>
          )}
        </section>
      </div>
    </ViewFrame>
  );
}

type Run = (action: () => Promise<unknown>, done: string | (() => string)) => Promise<boolean>;

function Box(props: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="box">
      <h2>{props.title}</h2>
      {props.children}
    </section>
  );
}

function CharacterLink(props: { id: string | null; name: string }) {
  const { archive } = useArchive();
  if (!props.id) return <>{props.name}</>;
  return (
    <button
      className="linkish"
      type="button"
      onClick={() => navigate(characterPath(archive.archiveId, props.id!))}
    >
      {props.name}
    </button>
  );
}

interface Field {
  key: string;
  label: string;
  options?: [string, string][];
  optional?: boolean;
}

/** A row of fields and a date, added together as one history entry. */
function AddRow(props: {
  fields: Field[];
  dateLabel: string;
  onAdd(values: Record<string, string | undefined>): Promise<boolean>;
}) {
  const { archive } = useArchive();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(props.fields.map((f) => [f.key, f.options?.[0]?.[0] ?? ""])),
  );
  const [date, setDate] = useState("");
  const ready = props.fields.every((f) => f.optional || values[f.key]?.trim());
  return (
    <form
      className="addrow"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready) return;
        const trimmed = Object.fromEntries(
          Object.entries(values).map(([k, v]) => [k, v.trim() || undefined]),
        );
        if (await props.onAdd({ ...trimmed, date: date.trim() || undefined })) {
          setValues(
            Object.fromEntries(props.fields.map((f) => [f.key, f.options?.[0]?.[0] ?? ""])),
          );
          setDate("");
        }
      }}
    >
      {props.fields.map((field) => (
        <label key={field.key} className="field">
          <span>{field.label}</span>
          {field.options ? (
            <select
              value={values[field.key]}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            >
              {field.options.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={values[field.key]}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            />
          )}
        </label>
      ))}
      <DateField
        archiveId={archive.archiveId}
        label={props.dateLabel}
        value={date}
        onChange={setDate}
        placeholder="Jul 15 2019"
      />
      <button className="btn primary" type="submit" disabled={!ready}>
        Add
      </button>
    </form>
  );
}

function IntroducedByForm(props: {
  characterId: string;
  onAdd(introducer: string, date: string | undefined): Promise<boolean>;
}) {
  const { archive } = useArchive();
  const [who, setWho] = useState<Picked[]>([]);
  const [date, setDate] = useState("");
  const chosen = who.filter((w) => w.id !== props.characterId);
  return (
    <form
      className="addrow"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!chosen.length) return;
        if (await props.onAdd(chosen[0]!.id, date.trim() || undefined)) {
          setWho([]);
          setDate("");
        }
      }}
    >
      <Picker
        archiveId={archive.archiveId}
        kind="character"
        label="Introduced by"
        value={who}
        onChange={(value) => setWho(value.slice(-1))}
      />
      <DateField
        archiveId={archive.archiveId}
        label="On (optional)"
        value={date}
        onChange={setDate}
        placeholder="Aug 3 2019"
      />
      <button className="btn primary" type="submit" disabled={!chosen.length}>
        Add
      </button>
    </form>
  );
}

function FactsForm(props: { character: CharacterView; run: Run; url: string }) {
  const { archive } = useArchive();
  const { character } = props;
  const [knownName, setKnownName] = useState(character.knownName);
  const [realName, setRealName] = useState(character.realName ?? "");
  const [birthDay, setBirthDay] = useState(character.birthDay ?? "");
  const [met, setMet] = useState(character.metInPerson);
  useEffect(() => {
    setKnownName(character.knownName);
    setRealName(character.realName ?? "");
    setBirthDay(character.birthDay ?? "");
    setMet(character.metInPerson);
  }, [character]);
  const unchanged =
    knownName === character.knownName &&
    realName === (character.realName ?? "") &&
    birthDay === (character.birthDay ?? "") &&
    met === character.metInPerson;
  return (
    <section className="box">
      <h2>Facts</h2>
      <div className="grid2">
        <label className="field">
          <span>Known name</span>
          <input value={knownName} onChange={(event) => setKnownName(event.target.value)} />
        </label>
        <label className="field">
          <span>Real name (optional)</span>
          <input value={realName} onChange={(event) => setRealName(event.target.value)} />
        </label>
        <DateField
          archiveId={archive.archiveId}
          label="Birth date (optional)"
          value={birthDay}
          onChange={setBirthDay}
          placeholder="Apr 12 2001"
        />
        <label className="field">
          <span>Met in person</span>
          <select
            value={met}
            onChange={(event) => setMet(event.target.value as CharacterView["metInPerson"])}
          >
            <option value="unknown">unknown</option>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </label>
      </div>
      {/* While there are unsaved facts, Save stays at the bottom of the window as the page scrolls. */}
      <div className={unchanged ? undefined : "sticky-actions"}>
        {unchanged ? null : <span className="hint grow">Unsaved changes to the facts</span>}
        <button
          className={unchanged ? "btn" : "btn primary"}
          type="button"
          disabled={unchanged || !knownName.trim()}
          onClick={() =>
            props.run(
              () =>
                api(props.url, {
                  method: "PATCH",
                  json: {
                    expectedVersion: character.version,
                    knownName,
                    realName: realName.trim() || null,
                    birthDay: birthDay.trim() || null,
                    metInPerson: met,
                  },
                }),
              "Saved.",
            )
          }
        >
          Save facts
        </button>
      </div>
    </section>
  );
}

/** Links an existing account to this character, or adds a new one. */
function AccountsForm(props: { character: CharacterView; run: Run }) {
  const { archive, me } = useArchive();
  const [existing, setExisting] = useState<Picked[]>([]);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"human" | "bot">("human");
  const [discordId, setDiscordId] = useState("");
  const base = `/api/archives/${archive.archiveId}/entities/account`;
  return (
    <>
      <form
        className="addrow"
        onSubmit={async (event) => {
          event.preventDefault();
          const pick = existing[0];
          if (!pick) return;
          const ok = await props.run(async () => {
            const account = await api<EntityView>(`${base}/${pick.id}`);
            await api(`${base}/${pick.id}`, {
              method: "PATCH",
              json: { expectedVersion: account.version, characterId: props.character.id },
            });
          }, `Linked ${pick.label}.`);
          if (ok) setExisting([]);
        }}
      >
        <Picker
          archiveId={archive.archiveId}
          kind="account"
          label="Link an existing account"
          value={existing}
          onChange={(value) => setExisting(value.slice(-1))}
        />
        <button className="btn primary" type="submit" disabled={!existing.length}>
          Link
        </button>
      </form>
      <form
        className="addrow"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!label.trim()) return;
          let note = "Added the account.";
          const ok = await props.run(
            async () => {
              const account = await api<EntityView>(base, {
                method: "POST",
                json: {
                  kind,
                  label: label.trim(),
                  discordId: discordId.trim() || undefined,
                  characterId: props.character.id,
                },
              });
              // With a Discord ID, the account's current avatar comes along when the service can ask Discord.
              if (discordId.trim() && me.features.discordLookups) {
                note = await fetchDiscordAvatar(archive.archiveId, account).then(
                  (found) => `Added the account. ${found}`,
                  (failure: unknown) =>
                    `Added the account, but its avatar could not be fetched: ${failure instanceof Error ? failure.message : failure}`,
                );
              }
            },
            () => note,
          );
          if (ok) {
            setLabel("");
            setDiscordId("");
          }
        }}
      >
        <label className="field">
          <span>New account name</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label className="field">
          <span>Kind</span>
          <select value={kind} onChange={(event) => setKind(event.target.value as "human" | "bot")}>
            <option value="human">Person's account</option>
            <option value="bot">Bot</option>
          </select>
        </label>
        <label className="field">
          <span>Discord ID (optional)</span>
          <input
            value={discordId}
            inputMode="numeric"
            onChange={(event) => setDiscordId(event.target.value)}
          />
        </label>
        <button className="btn primary" type="submit" disabled={!label.trim()}>
          Add
        </button>
      </form>
    </>
  );
}

function FallbackPictureForm(props: { character: CharacterView; run: Run; url: string }) {
  const [file, setFile] = useState<File | null>(null);
  return (
    <section className="box">
      <h2>Fallback picture</h2>
      <span className="hint">
        Used when no account picture is known. It is labeled as a fallback, never as a historical
        avatar.
      </span>
      <form
        className="addrow"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!file) return;
          const ok = await props.run(async () => {
            const form = new FormData();
            form.append("purpose", "fallback");
            form.append("expectedVersion", String(props.character.version));
            form.append("file", file, file.name);
            await api(`${props.url}/picture`, { method: "POST", form });
          }, "Saved the fallback picture.");
          if (ok) setFile(null);
        }}
      >
        <FileDrop label="Image" accept={IMAGE_ACCEPT} file={file} onFile={setFile} />
        <button className="btn primary" type="submit" disabled={!file}>
          Upload
        </button>
      </form>
    </section>
  );
}
