import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type ArtifactPage,
  type CharacterView,
  type EntityView,
  type EventPage,
  type HistoryEntry,
  mediaUrl,
  query,
} from "../api.js";
import { DateField } from "../components/DateField.js";
import { FileDrop, IMAGE_ACCEPT } from "../components/FileDrop.js";
import { Thumb } from "../components/Media.js";
import { type Picked, Picker } from "../components/Picker.js";
import { dayText, todayDay } from "../format.js";
import { CharacterMergeModal } from "../modals/CharacterMergeModal.js";
import { PicturesModal } from "../modals/PicturesModal.js";
import { characterPath, navigate, viewPath } from "../router.js";
import { useWindows } from "../Shell.js";
import { EMPTY_FILTERS, useArchive } from "../state.js";
import { Avatar, ErrorNote } from "../ui.js";
import { AddMenu } from "../components/AddMenu.js";
import { ViewFrame } from "./ViewFrame.js";

/**
 * A character's page: their known name, facts, aliases, main accounts,
 * accounts with dated names, avatars, and memberships, introductions, and
 * their artifacts and events. Dated history is edited here rather than in
 * Discord. Each change saves at once with the version just loaded, so
 * nothing overwrites someone else's edit.
 */

type Account = CharacterView["accounts"][number];

const ARTIFACTS_SHOWN = 24;

/** Whole years from a birth day to today. */
function ageOn(birthDay: string, today: string): number {
  const [by, bm, bd] = birthDay.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/**
 * The latest entry, as the service picks it outside the timeline: the latest
 * dated one, or an undated one when none is dated.
 */
function latestEntry(entries: HistoryEntry[]): HistoryEntry | undefined {
  const dated = entries.filter((entry) => entry.date);
  if (dated.length) {
    return dated.reduce((a, b) => (b.date!.archiveDay >= a.date!.archiveDay ? b : a));
  }
  return [...entries].sort((a, b) => b.id.localeCompare(a.id))[0];
}

/** The character's latest picture and where it comes from. */
function currentPicture(character: CharacterView): { mediaId: string | null; note: string } {
  const main = latestEntry(character.history.filter((entry) => entry.kind === "main_account"));
  const account = character.accounts.find((a) => a.id === main?.targetId);
  if (account) {
    const avatar = latestEntry(account.history.filter((entry) => entry.kind === "avatar"));
    if (avatar?.mediaId) {
      return {
        mediaId: avatar.mediaId,
        note: `the avatar of their main account, ${account.label}`,
      };
    }
  }
  if (character.fallbackMediaId) {
    return { mediaId: character.fallbackMediaId, note: "a fallback picture, not from an account" };
  }
  return { mediaId: null, note: "none known yet" };
}

const when = (entry: HistoryEntry) =>
  entry.date ? dayText(entry.date.archiveDay) : "date unknown";

const span = (entry: HistoryEntry) =>
  `${entry.start ? dayText(entry.start.archiveDay) : "unknown start"} to ${
    entry.end ? dayText(entry.end.archiveDay) : "now or unknown"
  }`;

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
    async (action: () => Promise<unknown>, done: string): Promise<boolean> => {
      setError(null);
      try {
        await action();
        changed();
        toast(done);
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

  const picture = currentPicture(character);
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
                picture={{ mediaId: picture.mediaId }}
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
              <b>Picture:</b> {picture.note}
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
            <Rows
              entries={history("alias")}
              editing={editing}
              render={(entry) => entry.name}
              onRemove={(entry) => removeEntry(own, character.version, entry, "Removed the alias.")}
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
            <Rows
              entries={history("main_account")}
              editing={editing}
              render={(entry) => `${entry.targetName ?? "An account"} from this date`}
              onRemove={(entry) =>
                removeEntry(own, character.version, entry, "Removed the main account.")
              }
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

          {character.accounts.map((account) => (
            <AccountBox
              key={account.id}
              account={account}
              editing={editing}
              run={run}
              onRemove={(entry, done) =>
                removeEntry(`account/${account.id}`, account.version, entry, done)
              }
              onAdd={(json, done) => addEntry(`account/${account.id}`, account.version, json, done)}
            />
          ))}

          <Box title="Introductions">
            <Rows
              entries={history("introduction")}
              editing={editing}
              render={(entry) => (
                <>
                  Introduced by{" "}
                  <CharacterLink id={entry.targetId} name={entry.targetName ?? "someone"} />
                </>
              )}
              onRemove={(entry) =>
                removeEntry(own, character.version, entry, "Removed the introduction.")
              }
            />
            {character.introduced.length ? (
              <div className="hist">
                {character.introduced.map((intro) => (
                  <div key={intro.characterId}>
                    <time>{intro.date ? dayText(intro.date.archiveDay) : "date unknown"}</time>
                    <span>
                      Introduced <CharacterLink id={intro.characterId} name={intro.knownName} />
                    </span>
                    <span />
                  </div>
                ))}
              </div>
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
            <AccountsForm character={character} run={run} />
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
                  title={item.description}
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

type Run = (action: () => Promise<unknown>, done: string) => Promise<boolean>;

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

/** History rows, oldest first with undated ones last, each removable while editing. */
function Rows(props: {
  entries: HistoryEntry[];
  editing: boolean;
  render(entry: HistoryEntry): ReactNode;
  onRemove(entry: HistoryEntry): void;
  dates?: (entry: HistoryEntry) => string;
}) {
  if (!props.entries.length) return <span className="hint">Nothing recorded.</span>;
  const day = (entry: HistoryEntry) =>
    entry.date?.archiveDay ?? entry.start?.archiveDay ?? "9999-12-31";
  const sorted = [...props.entries].sort((a, b) => day(a).localeCompare(day(b)));
  return (
    <div className="hist">
      {sorted.map((entry) => (
        <div key={`${entry.kind}:${entry.id}`}>
          <time>{props.dates ? props.dates(entry) : when(entry)}</time>
          <span>{props.render(entry)}</span>
          {props.editing ? (
            <button className="rm" type="button" onClick={() => props.onRemove(entry)}>
              Remove
            </button>
          ) : (
            <span />
          )}
        </div>
      ))}
    </div>
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

function AccountBox(props: {
  account: Account;
  editing: boolean;
  run: Run;
  onRemove(entry: HistoryEntry, done: string): void;
  onAdd(json: Record<string, unknown>, done: string): Promise<boolean>;
}) {
  const { archive } = useArchive();
  const { account, editing } = props;
  const names = account.history.filter((entry) => entry.kind === "account_name");
  const avatars = account.history.filter((entry) => entry.kind === "avatar");
  const memberships = account.history.filter((entry) => entry.kind === "membership");
  const others = account.history.filter(
    (entry) => entry.kind === "ownership" || entry.kind === "bot_owner",
  );
  return (
    <Box title={`Account: ${account.label}${account.accountKind === "bot" ? " (bot)" : ""}`}>
      {account.discordCreatedAt ? (
        <span className="hint">
          Discord account created {dayText(account.discordCreatedAt.slice(0, 10))}, from its ID
        </span>
      ) : null}
      {account.history.length ? null : <span className="hint">Nothing recorded.</span>}
      {names.length ? (
        <Rows
          entries={names}
          editing={editing}
          render={(entry) =>
            `Name: ${entry.name}${entry.discriminator ? `#${entry.discriminator}` : ""}`
          }
          onRemove={(entry) => props.onRemove(entry, "Removed the name.")}
        />
      ) : null}
      {avatars.length ? (
        <Rows
          entries={avatars}
          editing={editing}
          render={(entry) => (
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              {entry.mediaId ? (
                <span className="av sm">
                  {/* The original, so an animated GIF plays as it was uploaded. */}
                  <img src={mediaUrl(archive.archiveId, entry.mediaId)} alt="" loading="lazy" />
                </span>
              ) : null}
              Avatar
            </span>
          )}
          onRemove={(entry) => props.onRemove(entry, "Removed the avatar.")}
        />
      ) : null}
      {memberships.length ? (
        <Rows
          entries={memberships}
          editing={editing}
          dates={(entry) => (entry.start ? dayText(entry.start.archiveDay) : "date unknown")}
          render={(entry) => `Member of ${entry.targetName ?? "a server"}, ${span(entry)}`}
          onRemove={(entry) => props.onRemove(entry, "Removed the membership.")}
        />
      ) : null}
      {others.length ? (
        <Rows
          entries={others}
          editing={editing}
          dates={(entry) => (entry.start ? dayText(entry.start.archiveDay) : "")}
          render={(entry) =>
            entry.kind === "bot_owner"
              ? `Bot owned by ${entry.targetName ?? "someone"}`
              : `Owned by ${entry.targetName ?? "someone"}, ${span(entry)}`
          }
          onRemove={(entry) => props.onRemove(entry, "Removed it.")}
        />
      ) : null}
      {editing ? <AccountAddForms account={account} run={props.run} onAdd={props.onAdd} /> : null}
    </Box>
  );
}

/** Adds a name, an avatar image, or a server membership to an account. */
function AccountAddForms(props: {
  account: Account;
  run: Run;
  onAdd(json: Record<string, unknown>, done: string): Promise<boolean>;
}) {
  const { archive } = useArchive();
  const [what, setWhat] = useState<"name" | "avatar" | "membership">("name");
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [end, setEnd] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [server, setServer] = useState<Picked[]>([]);
  const reset = () => {
    setName("");
    setDate("");
    setEnd("");
    setFile(null);
    setServer([]);
  };
  const ready = what === "name" ? name.trim() : what === "avatar" ? file : server.length === 1;
  const submit = async () => {
    let ok = false;
    if (what === "name") {
      ok = await props.onAdd(
        { kind: "account_name", name: name.trim(), date: date.trim() || undefined },
        "Added the name.",
      );
    } else if (what === "membership") {
      ok = await props.onAdd(
        {
          kind: "membership",
          targetId: server[0]!.id,
          start: date.trim() || undefined,
          end: end.trim() || undefined,
        },
        "Added the membership.",
      );
    } else {
      ok = await props.run(async () => {
        const form = new FormData();
        form.append("purpose", "avatar");
        form.append("expectedVersion", String(props.account.version));
        if (date.trim()) form.append("date", date.trim());
        form.append("file", file!, file!.name);
        await api(
          `/api/archives/${archive.archiveId}/entities/account/${props.account.id}/picture`,
          { method: "POST", form },
        );
      }, "Added the avatar.");
    }
    if (ok) reset();
  };
  return (
    <form
      className="addrow"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void submit();
      }}
    >
      <label className="field">
        <span>Add</span>
        <select
          value={what}
          onChange={(event) => {
            setWhat(event.target.value as typeof what);
            reset();
          }}
        >
          <option value="name">Name</option>
          <option value="avatar">Avatar image</option>
          <option value="membership">Joined a server</option>
        </select>
      </label>
      {what === "name" ? (
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
      ) : what === "avatar" ? (
        <FileDrop
          label="Image (GIFs stay animated)"
          accept={IMAGE_ACCEPT}
          file={file}
          onFile={setFile}
        />
      ) : (
        <Picker
          archiveId={archive.archiveId}
          kind="server"
          label="Server"
          value={server}
          onChange={(value) => setServer(value.slice(-1))}
        />
      )}
      <DateField
        archiveId={archive.archiveId}
        label={what === "membership" ? "Joined (optional)" : "Seen on (optional)"}
        value={date}
        onChange={setDate}
        placeholder="Jul 15 2019"
      />
      {what === "membership" ? (
        <DateField
          archiveId={archive.archiveId}
          label="Left (optional)"
          value={end}
          onChange={setEnd}
          placeholder="Empty if still there"
        />
      ) : null}
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
  const { archive } = useArchive();
  const [existing, setExisting] = useState<Picked[]>([]);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"human" | "bot">("human");
  const [discordId, setDiscordId] = useState("");
  const base = `/api/archives/${archive.archiveId}/entities/account`;
  return (
    <section className="box">
      <h2>Accounts</h2>
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
          const ok = await props.run(
            () =>
              api(base, {
                method: "POST",
                json: {
                  kind,
                  label: label.trim(),
                  discordId: discordId.trim() || undefined,
                  characterId: props.character.id,
                },
              }),
            "Added the account.",
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
    </section>
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
