import { parseArgs } from "node:util";
import { closeArchivistContext, createArchivistContext } from "../archivist/context.js";
import { ArchivistError } from "../archivist/errors.js";
import { basePathOf } from "../archivist/web/settings.js";
import { readConfig } from "./config.js";
import { importBotState } from "./import-bot-state.js";
import { openOperationalDatabase, serve } from "./server.js";
import { DEFAULT_VIEWER_PORT, startViewer } from "./viewer.js";

/**
 * The Archivist command line. `serve` runs the service from the settings in
 * the environment. The other commands are tools for the owner's machine.
 */

const USAGE = `Usage: archivist <command>

Commands:
  serve                                Run the Archivist service with the settings in the environment.
  view <folder>... [--port <port>] [--host <address>]
                                       Open archive folders read-only in a website on this computer.
  import-bot-state <path to guhbot.db> Copy Archivist's registry, whitelists, and preferences from the
                                       bot's database into this service's data directory.
  healthcheck                          Exit successfully when the running service answers.
`;

const HEALTH_TIMEOUT_MS = 5_000;

/** Runs until the process is asked to stop, then closes cleanly. */
function stopOnSignal(close: () => Promise<void>): void {
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}, stopping.`);
    close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("Archivist could not stop cleanly:", error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function runServe(): Promise<void> {
  const config = readConfig();
  const service = await serve({ config });
  stopOnSignal(service.close);
  console.log(`Archivist is running at ${config.web.baseUrl}`);
}

async function runView(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { port: { type: "string" }, host: { type: "string" } },
  });
  const port = values.port === undefined ? DEFAULT_VIEWER_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ArchivistError("invalid_input", "--port must be a port number from 1 to 65535.");
  }
  const viewer = await startViewer({ folders: positionals, port, host: values.host });
  stopOnSignal(viewer.close);
  for (const archive of viewer.archives)
    console.log(`Opened ${archive.name} from ${archive.folder}`);
  console.log(`The archive viewer is at ${viewer.url}. Press Ctrl+C to stop it.`);
}

async function runImport(args: string[]): Promise<void> {
  const [file] = args;
  if (!file || args.length > 1) throw new ArchivistError("invalid_input", USAGE);
  const config = readConfig();
  const botDb = openOperationalDatabase(config.dataDir);
  try {
    const context = createArchivistContext({ dataDir: config.dataDir, botDb });
    try {
      const summary = importBotState(context, file);
      for (const [table, rows] of Object.entries(summary.copied)) {
        console.log(`Copied ${rows} row(s) of ${table}.`);
      }
      for (const [table, rows] of Object.entries(summary.kept)) {
        console.log(`Kept ${rows} row(s) of ${table} that the service already had.`);
      }
      for (const conflict of summary.nameConflicts) {
        console.warn(
          `Skipped archive ${conflict.archiveId} ("${conflict.name}"): the service already has another archive with that name. Rename one of them and import again.`,
        );
      }
      for (const archiveId of summary.missingFolders) {
        console.warn(
          `Archive ${archiveId} is registered, but its folder is not in ${context.paths.archivesRoot} yet. Copy archives/${archiveId} from the bot's data directory.`,
        );
      }
    } finally {
      closeArchivistContext(context);
    }
  } finally {
    botDb.close();
  }
}

/** Asks the service on this machine whether it answers, for the container's health check. */
async function runHealthcheck(): Promise<void> {
  const { web } = readConfig();
  const host = ["0.0.0.0", "::", ""].includes(web.host)
    ? "127.0.0.1"
    : web.host.includes(":")
      ? `[${web.host}]`
      : web.host;
  const url = `http://${host}:${web.port}${basePathOf(web.baseUrl)}/api/health`;
  const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
}

async function main(argv: string[]): Promise<void> {
  const [command = "serve", ...args] = argv;
  switch (command) {
    case "serve":
      return runServe();
    case "view":
      return runView(args);
    case "import-bot-state":
      return runImport(args);
    case "healthcheck":
      return runHealthcheck();
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      throw new ArchivistError("invalid_input", `Unknown command "${command}".\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof ArchivistError) console.error(error.message);
  else console.error(error);
  process.exitCode = 1;
});
