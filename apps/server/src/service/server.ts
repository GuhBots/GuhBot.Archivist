import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { settleExpiredClaims } from "../archivist/announcements.js";
import {
  type ArchivistContext,
  closeArchivistContext,
  createArchivistContext,
} from "../archivist/context.js";
import { settleInterruptedExports } from "../archivist/exports.js";
import { cleanStaging } from "../archivist/media.js";
import { closeMetadataReader } from "../archivist/metadata.js";
import { buildWebApp } from "../archivist/web/app.js";
import type { Fetch } from "../archivist/web/discord-oauth.js";
import { WebListener, type WebStatus } from "../archivist/web/listener.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerAnnouncementRoutes } from "./announcement-routes.js";
import { registerBotRoutes } from "./bot-routes.js";
import { checkServiceConfig, type ServiceConfig } from "./config.js";
import { serviceAuth } from "./service-auth.js";

/**
 * Runs the Archivist service: one listener for the website, its JSON routes,
 * and the bot's API, over the archives in the data directory. The service
 * keeps its own operational database there, so it needs nothing from the
 * bot's host.
 */

/** The operational database's file in the data directory. */
export const OPERATIONAL_DATABASE = "operational.db";

/** How often leftover staging folders are removed and expired announcement claims settled. */
const SWEEP_INTERVAL_MS = 60_000;

export type ErrorLog = (message: string, error: unknown) => void;

/** Opens the operational database, creating the data directory and file when needed. */
export function openOperationalDatabase(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, OPERATIONAL_DATABASE));
  // Readers do not wait for a writer, and the file is never exported, so WAL suits it.
  db.pragma("journal_mode = WAL");
  return db;
}

export interface ServiceAppOptions {
  context: ArchivistContext;
  config: ServiceConfig;
  logError: ErrorLog;
  /** Replaced in tests, which stand in for Discord and Google Drive. */
  fetch?: Fetch;
}

/** The service's HTTP app: the website and its routes, plus the bot's API and a health check. */
export function buildServiceApp(options: ServiceAppOptions): FastifyInstance {
  const { context, config, logError } = options;
  const service = serviceAuth({ token: config.serviceToken, ownerIds: config.ownerIds });
  return buildWebApp({
    context,
    settings: config.web,
    isOwner: async (userId) => config.ownerIds.has(userId),
    // The owner list is in memory, so every request sees the configured owners.
    ownerRecheckMs: 0,
    identify: service.identify,
    hasServiceCredential: service.hasCredential,
    frontendRoot: config.frontendRoot,
    driveApiKey: config.driveApiKey,
    logError,
    fetch: options.fetch,
    extend(scope, auth) {
      scope.get("/api/health", async () => ({ status: "ok" }));
      registerBotRoutes(scope, context, auth);
      registerAdminRoutes(scope, context, auth, logError);
      registerAnnouncementRoutes(scope, context, service, logError);
    },
  }).app;
}

export interface RunningService {
  context: ArchivistContext;
  status(): WebStatus;
  /** Stops the listener after requests in progress, then closes the archives and databases. */
  close(): Promise<void>;
}

export interface ServeOptions {
  config: ServiceConfig;
  log?: Pick<Console, "warn" | "error">;
  now?: () => Date;
  fetch?: Fetch;
}

export async function serve(options: ServeOptions): Promise<RunningService> {
  const { config } = options;
  const log = options.log ?? console;
  checkServiceConfig(config);
  const botDb = openOperationalDatabase(config.dataDir);
  let context: ArchivistContext;
  try {
    context = createArchivistContext({ dataDir: config.dataDir, botDb, now: options.now });
  } catch (error) {
    botDb.close();
    throw error;
  }
  const logError: ErrorLog = (message, error) => log.error(`Archivist: ${message}:`, error);

  cleanStaging(context);
  const interrupted = settleInterruptedExports(context);
  if (interrupted > 0) log.warn(`Archivist: ${interrupted} export(s) were interrupted and failed.`);
  settleExpiredClaims(context);
  const sweeper = setInterval(() => {
    try {
      cleanStaging(context);
      settleExpiredClaims(context);
    } catch (error) {
      logError("Routine cleanup failed", error);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  const listener = new WebListener({
    host: config.web.host,
    port: config.web.port,
    url: config.web.baseUrl,
    build: () => buildServiceApp({ context, config, logError, fetch: options.fetch }),
    now: options.now,
  });
  const close = async () => {
    clearInterval(sweeper);
    await listener.stop();
    closeArchivistContext(context);
    botDb.close();
    await closeMetadataReader();
  };
  try {
    await listener.start();
  } catch (error) {
    await close();
    throw error;
  }

  if (config.serviceToken === null) {
    log.warn(
      "Archivist: ARCHIVIST_SERVICE_TOKEN is not set, so the Discord bot cannot use the API.",
    );
  }
  return { context, status: () => listener.status(), close };
}
