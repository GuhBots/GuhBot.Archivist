import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type EntityView, type HistoryEntry, mediaUrl } from "../api.js";
import { DateField } from "../components/DateField.js";
import { FileDrop, IMAGE_ACCEPT } from "../components/FileDrop.js";
import { blockersText, type HistoryChange, HistoryRows, spanText } from "../components/History.js";
import { type Picked, Picker } from "../components/Picker.js";
import { useCharacterNames } from "../components/use-names.js";
import { dayText } from "../format.js";
import { characterPath, navigate } from "../router.js";
import { useWindows } from "../Shell.js";
import { useArchive } from "../state.js";
import { Avatar, ErrorNote, Modal } from "../ui.js";
import { DeleteModal } from "./DeleteModal.js";

type Account = Extract<EntityView, { kind: "account" }>;

/** What a Discord avatar lookup found, as a short note. */
const AVATAR_RESULTS: Record<string, string> = {
  added: "Added their current Discord avatar, dated today.",
  unchanged: "Their Discord avatar is the latest one already.",
  default_avatar: "They use Discord's default avatar, so there is nothing to add.",
};

/**
 * Asks the service to record an account's current Discord avatar. Returns
 * the note to show, or throws as any call does.
 */
export async function fetchDiscordAvatar(
  archiveId: string,
  account: { id: string; version: number },
): Promise<string> {
  const result = await api<{ status: string }>(
    `/api/archives/${archiveId}/entities/account/${account.id}/discord-avatar`,
    { method: "POST", json: { expectedVersion: account.version } },
  );
  return AVATAR_RESULTS[result.status] ?? "Checked Discord.";
}

/**
 * One account in its own window: its picture, names, Discord ID, and the
 * dated names, avatars, and server memberships behind them, all editable.
 * It replaces the per-account sections that crowded a character's page.
 */
export function AccountModal(props: { accountId: string }) {
  const { archive, me, revision, changed, toast } = useArchive();
  const windows = useWindows();
  const names = useCharacterNames(archive.archiveId, revision);
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<unknown>(null);
  const url = `/api/archives/${archive.archiveId}/entities/account/${props.accountId}`;

  const load = useCallback(async () => setAccount(await api<Account>(url)), [url]);
  useEffect(() => {
    load().catch(setError);
  }, [load]);

  /**
   * Saves a change, reloads, and lets the page behind reload too. An action
   * may return its own note to show instead of `done`. A stale version says why.
   */
  const run: Run = async (action, done) => {
    setError(null);
    try {
      const note = await action();
      await load();
      changed();
      toast(typeof note === "string" && note ? note : done);
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "stale_version") {
        await load().catch(() => undefined);
        setError(new Error("Someone else changed this account. Its current values are shown."));
      } else setError(failure);
      return false;
    }
  };

  if (!account) {
    return (
      <Modal title="Account" wide onClose={windows.close}>
        <div className="content">{error ? <ErrorNote error={error} /> : "Loading…"}</div>
      </Modal>
    );
  }

  const of = (kind: HistoryEntry["kind"]) => account.history.filter((e) => e.kind === kind);
  const remove = (entry: HistoryEntry, done: string) =>
    run(
      () =>
        api(
          `${url}/history/${entry.id}?historyKind=${entry.kind}&expectedVersion=${account.version}`,
          { method: "DELETE" },
        ),
      done,
    );
  const edit = (entry: HistoryEntry, change: HistoryChange) =>
    run(
      () =>
        api(`${url}/history/${entry.id}`, {
          method: "PATCH",
          json: { historyKind: entry.kind, expectedVersion: account.version, ...change },
        }),
      "Saved.",
    );
  const blocked = Object.keys(account.blockers).length > 0;

  return (
    <Modal
      title={`Account: ${account.name}`}
      wide
      onClose={windows.close}
      footer={
        <>
          <button
            className="btn danger"
            type="button"
            disabled={blocked}
            title={blocked ? "Remove what links to it first" : undefined}
            onClick={() =>
              windows.show(
                <DeleteModal
                  what={`the account ${account.name}`}
                  path={`/entities/account/${account.id}`}
                  version={account.version}
                  onDeleted={() => undefined}
                  onKeep={() => windows.show(<AccountModal accountId={account.id} />)}
                />,
              )
            }
          >
            Delete account
          </button>
          <span className="grow" />
          <button className="btn primary" type="button" onClick={windows.close}>
            Done
          </button>
        </>
      }
    >
      <div className="content">
        <div className="char-head">
          <Avatar
            archiveId={archive.archiveId}
            picture={{ mediaId: account.avatarMediaId }}
            name={account.name}
            size="lg"
          />
          <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
            <strong style={{ fontSize: 18 }}>{account.name}</strong>
            <span className="hint">
              {account.accountKind === "bot" ? "Bot account" : "Person's account"}
              {account.discordId ? ` · Discord ID ${account.discordId}` : " · No Discord ID yet"}
            </span>
            {account.discordCreatedAt ? (
              <span className="hint">
                Created on Discord {dayText(account.discordCreatedAt.slice(0, 10))}, from its ID
              </span>
            ) : null}
            <span className="hint">
              {account.characterId ? (
                <>
                  Belongs to{" "}
                  <button
                    className="linkish"
                    type="button"
                    onClick={() => {
                      windows.close();
                      navigate(characterPath(archive.archiveId, account.characterId!));
                    }}
                  >
                    {names[account.characterId] ?? "their character"}
                  </button>
                </>
              ) : account.accountKind === "human" ? (
                "Not linked to a character"
              ) : null}
            </span>
          </div>
        </div>
        {blocked ? (
          <p className="hint" style={{ margin: 0 }}>
            To delete this account, first remove what links to it: {blockersText(account.blockers)}.
          </p>
        ) : null}
        <ErrorNote error={error} />

        <AccountFields account={account} run={run} />

        <section className="box">
          <h2>Names</h2>
          <HistoryRows
            entries={of("account_name")}
            editing
            empty={`No dated names. It goes by "${account.label}".`}
            render={(entry) =>
              `${entry.name}${entry.discriminator ? `#${entry.discriminator}` : ""}`
            }
            onRemove={(entry) => remove(entry, "Removed the name.")}
            onEdit={edit}
          />
        </section>
        <section className="box">
          <h2>
            Avatars
            {account.discordId && me.features.discordLookups ? (
              <button
                className="btn"
                type="button"
                onClick={() =>
                  run(() => fetchDiscordAvatar(archive.archiveId, account), "Checked Discord.")
                }
              >
                Get from Discord
              </button>
            ) : null}
          </h2>
          <HistoryRows
            entries={of("avatar")}
            editing
            empty="No avatars yet."
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
            onRemove={(entry) => remove(entry, "Removed the avatar.")}
            onEdit={edit}
          />
          {!me.features.discordLookups && account.discordId ? (
            <span className="hint">
              Avatars can come from Discord by ID once the owner sets DISCORD_BOT_TOKEN.
            </span>
          ) : null}
        </section>
        <section className="box">
          <h2>Server memberships</h2>
          <HistoryRows
            entries={of("membership")}
            editing
            empty="No memberships recorded."
            dates={(entry) => (entry.start ? dayText(entry.start.archiveDay) : "date unknown")}
            render={(entry) => `Member of ${entry.targetName ?? "a server"}, ${spanText(entry)}`}
            onRemove={(entry) => remove(entry, "Removed the membership.")}
            onEdit={edit}
          />
        </section>
        {of("ownership").length || of("bot_owner").length ? (
          <section className="box">
            <h2>Owners</h2>
            <HistoryRows
              entries={[...of("ownership"), ...of("bot_owner")]}
              editing
              dates={(entry) => (entry.start ? dayText(entry.start.archiveDay) : "")}
              render={(entry) =>
                entry.kind === "bot_owner"
                  ? `Bot owned by ${entry.targetName ?? "someone"}`
                  : `Owned by ${entry.targetName ?? "someone"}, ${spanText(entry)}`
              }
              onRemove={(entry) => remove(entry, "Removed it.")}
              onEdit={edit}
            />
          </section>
        ) : null}
        <section className="box">
          <h2>Add to this account</h2>
          <AccountAddForms account={account} run={run} />
        </section>
      </div>
    </Modal>
  );
}

type Run = (action: () => Promise<unknown>, done: string) => Promise<boolean>;

/** The account's own fields: its name, Discord ID, kind, and character link. */
function AccountFields(props: { account: Account; run: Run }) {
  const { archive, me } = useArchive();
  const { account } = props;
  const [label, setLabel] = useState(account.label);
  const [discordId, setDiscordId] = useState(account.discordId ?? "");
  const [kind, setKind] = useState(account.accountKind);
  useEffect(() => {
    setLabel(account.label);
    setDiscordId(account.discordId ?? "");
    setKind(account.accountKind);
  }, [account]);
  const unchanged =
    label === account.label &&
    discordId.trim() === (account.discordId ?? "") &&
    kind === account.accountKind;
  const url = `/api/archives/${archive.archiveId}/entities/account/${account.id}`;
  return (
    <section className="box">
      <h2>Details</h2>
      <div className="grid2">
        <label className="field">
          <span>Name before any dated name</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label className="field">
          <span>Discord ID (optional)</span>
          <input
            value={discordId}
            inputMode="numeric"
            onChange={(event) => setDiscordId(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Kind</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as Account["accountKind"])}
          >
            <option value="human">Person's account</option>
            <option value="bot">Bot</option>
          </select>
        </label>
      </div>
      <div className="row-actions">
        <button
          className={unchanged ? "btn" : "btn primary"}
          type="button"
          disabled={unchanged || !label.trim()}
          onClick={() =>
            props.run(async () => {
              const saved = await api<Account>(url, {
                method: "PATCH",
                json: {
                  expectedVersion: account.version,
                  label,
                  discordId: discordId.trim() || null,
                  subkind: kind,
                },
              });
              // A new Discord ID brings its avatar along when the service can ask Discord.
              if (
                saved.discordId &&
                saved.discordId !== account.discordId &&
                me.features.discordLookups
              ) {
                const note = await fetchDiscordAvatar(archive.archiveId, saved).catch(
                  (failure: unknown) =>
                    `Saved, but the avatar could not be fetched: ${failure instanceof Error ? failure.message : failure}`,
                );
                return `Saved. ${note}`;
              }
              return "Saved.";
            }, "Saved.")
          }
        >
          Save details
        </button>
        {account.characterId ? (
          <button
            className="btn ghost"
            type="button"
            onClick={() =>
              props.run(
                () =>
                  api(url, {
                    method: "PATCH",
                    json: { expectedVersion: account.version, characterId: null },
                  }),
                "Unlinked the account.",
              )
            }
          >
            Unlink from their character
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** Adds a name, an avatar image, or a server membership to an account. */
function AccountAddForms(props: { account: Account; run: Run }) {
  const { archive } = useArchive();
  const [what, setWhat] = useState<"name" | "avatar" | "membership">("name");
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [end, setEnd] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [server, setServer] = useState<Picked[]>([]);
  const url = `/api/archives/${archive.archiveId}/entities/account/${props.account.id}`;
  const reset = () => {
    setName("");
    setDate("");
    setEnd("");
    setFile(null);
    setServer([]);
  };
  const ready = what === "name" ? name.trim() : what === "avatar" ? file : server.length === 1;
  const submit = async () => {
    let ok: boolean;
    if (what === "avatar") {
      ok = await props.run(async () => {
        const form = new FormData();
        form.append("purpose", "avatar");
        form.append("expectedVersion", String(props.account.version));
        if (date.trim()) form.append("date", date.trim());
        form.append("file", file!, file!.name);
        await api(`${url}/picture`, { method: "POST", form });
      }, "Added the avatar.");
    } else {
      const json =
        what === "name"
          ? { kind: "account_name", name: name.trim(), date: date.trim() || undefined }
          : {
              kind: "membership",
              targetId: server[0]!.id,
              start: date.trim() || undefined,
              end: end.trim() || undefined,
            };
      ok = await props.run(
        () =>
          api(`${url}/history`, {
            method: "POST",
            json: { ...json, expectedVersion: props.account.version },
          }),
        what === "name" ? "Added the name." : "Added the membership.",
      );
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
