import type {} from "@fastify/cookie";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type { Actor, ArchivistContext } from "../../src/archivist/context.js";
import { createSession } from "../../src/archivist/web/sessions.js";
import type { ServiceConfig } from "../../src/service/config.js";
import { buildServiceApp } from "../../src/service/server.js";
import { ACTING_USER_HEADER } from "../../src/service/service-auth.js";
import { makeArchivist, MEMBER, NOW, OTHER, OWNER } from "../archivist/helpers/context.js";
import { makeTempDir } from "../archivist/helpers/temp-dir.js";

/**
 * The whole service app, as `serve` builds it, on a temporary data directory
 * and an in-memory request injector. Discord and Google are never reached:
 * `fetch` throws unless a test replaces it.
 */

export { MEMBER, NOW, OTHER, OWNER };

/** A service credential for tests only. Real ones come from `openssl rand -hex 32`. */
export const SERVICE_TOKEN = "t".repeat(64);

export function testConfig(dataDir: string, overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    dataDir,
    web: {
      host: "127.0.0.1",
      port: 0,
      baseUrl: "http://localhost:3000",
      discordClientId: "707321853198467163",
      discordClientSecret: "test-client-secret",
      sessionSecret: "s".repeat(64),
    },
    ownerIds: new Set([OWNER.userId]),
    serviceToken: SERVICE_TOKEN,
    driveApiKey: undefined,
    // A folder with no built pages, so pages show the "not built" notice.
    frontendRoot: join(dataDir, "no-frontend"),
    ...overrides,
  };
}

export interface ServiceHarness {
  app: FastifyInstance;
  context: ArchivistContext;
  config: ServiceConfig;
  /** Moves the clock the service and its sessions use. */
  clock: { ms: number };
  origin: string;
  /** Headers for a bot request acting for a Discord user, with the right credential. */
  bot(userId: string, extra?: Record<string, string>): Record<string, string>;
  /** Headers for a bot request that acts for nobody, as the announcement routes are. */
  botOnly(extra?: Record<string, string>): Record<string, string>;
  /** A signed session cookie value for the actor, as if they had signed in with Discord. */
  cookie(actor: Actor): string;
  /** Injects a request. */
  inject(options: InjectOptions): Promise<LightMyRequestResponse>;
  /** Errors the service logged, which tests may inspect. */
  logged: { message: string; error: unknown }[];
}

export interface HarnessOptions {
  config?: Partial<ServiceConfig>;
  fetch?: typeof fetch;
}

export async function serviceHarness(
  t: TestContext,
  options: HarnessOptions = {},
): Promise<ServiceHarness> {
  const { context, dataDir } = makeArchivist(t);
  const clock = { ms: NOW.getTime() };
  context.now = () => new Date(clock.ms);
  const config = testConfig(dataDir, {
    frontendRoot: makeTempDir(t),
    ...options.config,
  });
  const logged: ServiceHarness["logged"] = [];
  const app = buildServiceApp({
    context,
    config,
    logError: (message, error) => logged.push({ message, error }),
    fetch:
      options.fetch ??
      ((async () => {
        throw new Error("Tests do not reach Discord or Google.");
      }) as typeof fetch),
  });
  await app.ready();
  t.after(() => app.close());
  const token = config.serviceToken ?? SERVICE_TOKEN;
  return {
    app,
    context,
    config,
    clock,
    origin: new URL(config.web.baseUrl).origin,
    bot: (userId, extra = {}) => ({
      authorization: `Bearer ${token}`,
      [ACTING_USER_HEADER]: userId,
      ...extra,
    }),
    botOnly: (extra = {}) => ({ authorization: `Bearer ${token}`, ...extra }),
    cookie(actor) {
      const sessionToken = createSession(context, {
        userId: actor.userId,
        isOwner: actor.isOwner,
        displayName: "Tester",
        avatarUrl: null,
      });
      return app.signCookie(sessionToken);
    },
    inject: (injectOptions) => app.inject(injectOptions),
    logged,
  };
}

/** Encodes form fields, then an optional file last, as a multipart body for `inject`. */
export async function multipart(
  fields: Record<string, string | string[]>,
  file?: { name: string; bytes: Buffer; field?: string },
): Promise<{ payload: Buffer; contentType: string }> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) form.append(name, item);
  }
  if (file) form.append(file.field ?? "file", new Blob([file.bytes]), file.name);
  const encoded = new Request("http://localhost/", { method: "POST", body: form });
  return {
    payload: Buffer.from(await encoded.arrayBuffer()),
    contentType: encoded.headers.get("content-type")!,
  };
}
