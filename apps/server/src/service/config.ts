import { fileURLToPath } from "node:url";
import { ArchivistError } from "../archivist/errors.js";
import { checkWebSettings, type WebSettings } from "../archivist/web/settings.js";

/**
 * The service's settings, read from environment variables. This is the only
 * module that reads the environment. Everything else takes these values as
 * arguments, so tests can pass their own.
 */

export interface ServiceConfig {
  /** Holds the operational database, the archives, temporary files, and exports. */
  dataDir: string;
  web: WebSettings;
  /** Discord user IDs of the owners, who administer archives and see every one. */
  ownerIds: ReadonlySet<string>;
  /** The Discord bot's credential for the API, or null to refuse the bot. */
  serviceToken: string | null;
  /** Switches public Drive links to Google's official API. */
  driveApiKey: string | undefined;
  /** The built website. */
  frontendRoot: string;
}

/** Service credentials shorter than this are refused. */
export const MIN_SERVICE_TOKEN_BYTES = 32;

/** The built pages, from `apps/web`, beside this workspace in the repository and the image. */
export const DEFAULT_FRONTEND_ROOT = fileURLToPath(new URL("../../../web/dist/", import.meta.url));

const DISCORD_ID = /^\d{17,20}$/;

function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** Discord user IDs separated by commas or spaces. A malformed entry is refused rather than skipped. */
export function parseOwnerIds(text: string | undefined): Set<string> {
  const ids = (text ?? "").split(/[\s,]+/).filter(Boolean);
  const wrong = ids.find((id) => !DISCORD_ID.test(id));
  if (wrong !== undefined) {
    throw new ArchivistError(
      "invalid_input",
      `ARCHIVIST_OWNER_IDS must list Discord user IDs separated by commas, and "${wrong}" is not one.`,
      { reason: "invalid_owner_ids" },
    );
  }
  return new Set(ids);
}

function portValue(text: string | undefined): number {
  if (text === undefined) return 3000;
  const port = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(port) || port > 65535) {
    throw new ArchivistError("invalid_input", "ARCHIVIST_PORT must be a port number.", {
      reason: "invalid_port",
    });
  }
  return port;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    dataDir: setting(env, "DATA_DIR") ?? "data",
    web: {
      host: setting(env, "ARCHIVIST_HOST") ?? "127.0.0.1",
      port: portValue(setting(env, "ARCHIVIST_PORT")),
      baseUrl: setting(env, "ARCHIVIST_BASE_URL") ?? "http://localhost:3000",
      discordClientId: setting(env, "DISCORD_CLIENT_ID"),
      discordClientSecret: setting(env, "DISCORD_CLIENT_SECRET"),
      sessionSecret: setting(env, "ARCHIVIST_SESSION_SECRET"),
    },
    ownerIds: parseOwnerIds(setting(env, "ARCHIVIST_OWNER_IDS")),
    serviceToken: setting(env, "ARCHIVIST_SERVICE_TOKEN") ?? null,
    driveApiKey: setting(env, "GOOGLE_DRIVE_API_KEY"),
    frontendRoot: DEFAULT_FRONTEND_ROOT,
  };
}

/** The settings `serve` needs, or an error naming what is missing or wrong. */
export function checkServiceConfig(config: ServiceConfig): void {
  checkWebSettings(config.web);
  if (
    config.serviceToken !== null &&
    Buffer.byteLength(config.serviceToken, "utf8") < MIN_SERVICE_TOKEN_BYTES
  ) {
    throw new ArchivistError(
      "invalid_input",
      `ARCHIVIST_SERVICE_TOKEN must be at least ${MIN_SERVICE_TOKEN_BYTES} bytes. Generate one with \`openssl rand -hex 32\`.`,
      { reason: "short_service_token" },
    );
  }
}
