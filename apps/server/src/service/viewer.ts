import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { Actor, ArchivistContext } from "../archivist/context.js";
import { closeArchivistContext, createArchivistContext, openStore } from "../archivist/context.js";
import { ArchivistError } from "../archivist/errors.js";
import { nameKey, timestamp } from "../archivist/fields.js";
import { closeMetadataReader } from "../archivist/metadata.js";
import { ARCHIVE_SCHEMA_VERSION } from "../archivist/migrations/archive-schema.js";
import { archiveFolder, archiveIdValue, archiveRelativePath } from "../archivist/paths.js";
import { buildWebApp } from "../archivist/web/app.js";
import { WebListener } from "../archivist/web/listener.js";
import { DEFAULT_FRONTEND_ROOT } from "./config.js";

/**
 * The local viewer opens archive folders, such as an unzipped export, in a
 * website on this computer. It needs no Discord sign-in, settings, or
 * operational database, and it changes nothing in the folders: each
 * archive's database is copied into a temporary folder and opened there,
 * migrated if it is older than this build, and media files are read where
 * they are. Every change is refused, except the viewer's own date
 * preferences, which last until it stops.
 */

/** The contributor every viewer request acts as. It owns nothing outside the viewer. */
export const LOCAL_ACTOR: Actor = { userId: "local", isOwner: true };
export const DEFAULT_VIEWER_PORT = 3001;

/** Changes the viewer allows: the account menu's preferences, kept in memory. */
const ALLOWED_CHANGES = [/\/api\/me\/(timezone|date-order|preferences)$/, /\/auth\/logout$/];

export interface OpenedArchive {
  archiveId: string;
  name: string;
  /** The folder as given, or the archive folder found inside it. */
  folder: string;
  schemaVersion: number;
}

export interface ViewerOptions {
  folders: readonly string[];
  /** The address to listen on. Only this computer can reach the default. */
  host?: string;
  port?: number;
  /** The address browsers use. `http://localhost:<port>` unless given. */
  baseUrl?: string;
  frontendRoot?: string;
  log?: Pick<Console, "error">;
}

export interface RunningViewer {
  url: string;
  archives: OpenedArchive[];
  context: ArchivistContext;
  /** Stops the website and removes the temporary copies. */
  close(): Promise<void>;
}

function refuse(message: string, details: Record<string, unknown> = {}): ArchivistError {
  return new ArchivistError("invalid_input", message, details);
}

/**
 * The archive folder a path names: the folder itself when it holds
 * `archive.db`, or the only archive folder inside it, as unzipping an export
 * leaves one.
 */
export function findArchiveFolder(path: string): string {
  const folder = resolve(path);
  if (/\.zip$/i.test(folder)) {
    throw refuse(`${path} is a zip file. Unzip it first, then open the folder it makes.`, {
      reason: "zipped_archive",
    });
  }
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw refuse(`${path} is not a folder.`, { reason: "not_a_folder" });
  }
  if (existsSync(join(folder, "archive.db"))) return folder;
  const inside = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(folder, entry.name, "archive.db")))
    .map((entry) => join(folder, entry.name));
  if (inside.length === 1) return inside[0]!;
  throw refuse(
    inside.length === 0
      ? `${path} does not contain an archive. An archive folder holds archive.db.`
      : `${path} contains several archives. Open each archive folder by name.`,
    { reason: inside.length === 0 ? "not_an_archive" : "several_archives" },
  );
}

/** Reads an archive's identity without changing its file, refusing schemas newer than this build. */
function readIdentity(folder: string): OpenedArchive {
  const db = new Database(join(folder, "archive.db"), { readonly: true, fileMustExist: true });
  try {
    const schemaVersion = db.pragma("user_version", { simple: true }) as number;
    if (schemaVersion > ARCHIVE_SCHEMA_VERSION) {
      throw new ArchivistError(
        "unsupported_schema",
        `${folder} uses archive schema version ${schemaVersion}, but this viewer reads up to ${ARCHIVE_SCHEMA_VERSION}. Update GuhBot.Archivist.`,
        { schemaVersion, supportedVersion: ARCHIVE_SCHEMA_VERSION },
      );
    }
    const hasMeta = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'archive_meta'")
      .get();
    const meta = hasMeta
      ? (db.prepare("SELECT archive_id AS archiveId, name FROM archive_meta").get() as
          { archiveId: string; name: string } | undefined)
      : undefined;
    if (!meta) throw refuse(`${folder} has no archive details.`, { reason: "not_an_archive" });
    return {
      archiveId: archiveIdValue("archiveId", meta.archiveId),
      name: meta.name,
      folder,
      schemaVersion,
    };
  } finally {
    db.close();
  }
}

/** A display name not yet used in the viewer, since registered names must differ. */
function uniqueName(db: Database.Database, name: string): string {
  const taken = db.prepare("SELECT 1 FROM archivist_archives WHERE name_key = ?");
  let candidate = name;
  for (let copy = 2; taken.get(nameKey(candidate)); copy += 1) candidate = `${name} (${copy})`;
  return candidate;
}

/**
 * Places a read-only working copy of an archive: a snapshot of its database,
 * a copy of its edit log, and its media folder linked rather than copied,
 * since media can be very large and is only read.
 */
async function placeCopy(context: ArchivistContext, archive: OpenedArchive): Promise<void> {
  const target = archiveFolder(context.paths, archive.archiveId);
  mkdirSync(target, { recursive: true });
  const source = new Database(join(archive.folder, "archive.db"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    // SQLite's backup reads a consistent snapshot even while another program writes.
    await source.backup(join(target, "archive.db"));
  } finally {
    source.close();
  }
  const log = join(archive.folder, "edits.log");
  if (existsSync(log)) copyFileSync(log, join(target, "edits.log"));
  else writeFileSync(join(target, "edits.log"), "");
  const media = join(archive.folder, "media");
  if (existsSync(media)) symlinkSync(media, join(target, "media"), "dir");
  else mkdirSync(join(target, "media"));
}

export async function startViewer(options: ViewerOptions): Promise<RunningViewer> {
  if (options.folders.length === 0) throw refuse("Name at least one archive folder to open.");
  const found = options.folders.map(findArchiveFolder);
  const archives: OpenedArchive[] = [];
  for (const folder of found) {
    const archive = readIdentity(folder);
    if (!archives.some((opened) => opened.archiveId === archive.archiveId)) archives.push(archive);
  }

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_VIEWER_PORT;
  const baseUrl = options.baseUrl ?? `http://localhost:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "archivist-view-"));
  const botDb = new Database(":memory:");
  let context: ArchivistContext | undefined;
  let listener: WebListener | undefined;
  const close = async () => {
    await listener?.stop();
    if (context) closeArchivistContext(context);
    botDb.close();
    await closeMetadataReader();
    rmSync(dataDir, { recursive: true, force: true });
  };

  try {
    context = createArchivistContext({ dataDir, botDb });
    const register = botDb.prepare(
      `INSERT INTO archivist_archives (archive_id, name, name_key, relative_path, registered_at, registered_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const archive of archives) {
      await placeCopy(context, archive);
      archive.name = uniqueName(botDb, archive.name);
      register.run(
        archive.archiveId,
        archive.name,
        nameKey(archive.name),
        archiveRelativePath(archive.archiveId),
        timestamp(),
        LOCAL_ACTOR.userId,
      );
      // Opening now migrates the copy and reports a damaged archive before the website starts.
      openStore(context, archive.archiveId);
    }

    const opened = context;
    const log = options.log ?? console;
    listener = new WebListener({
      host,
      port,
      url: baseUrl,
      build: () =>
        buildWebApp({
          context: opened,
          settings: {
            host,
            port,
            baseUrl,
            // Signs nothing that outlives this run, so a fresh secret each time is enough.
            sessionSecret: randomBytes(32).toString("hex"),
          },
          isOwner: async () => true,
          identify: () => ({ actor: LOCAL_ACTOR, via: "local", name: "Local viewer" }),
          frontendRoot: options.frontendRoot ?? DEFAULT_FRONTEND_ROOT,
          logError: (message, error) => log.error(`Archivist viewer: ${message}:`, error),
          extend(scope) {
            scope.addHook("onRequest", async (request) => {
              if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
              const path = request.url.split("?")[0] ?? "";
              if (ALLOWED_CHANGES.some((allowed) => allowed.test(path))) return;
              throw new ArchivistError(
                "forbidden",
                "The local viewer only reads archives. Open the archive in the Archivist service to change it.",
                { reason: "read_only" },
              );
            });
          },
        }).app,
    });
    await listener.start();
  } catch (error) {
    await close();
    throw error;
  }
  return { url: baseUrl, archives, context, close };
}
