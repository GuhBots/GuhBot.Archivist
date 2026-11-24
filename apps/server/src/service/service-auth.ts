import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { ArchivistError } from "../archivist/errors.js";
import { type Delegated, SESSION_COOKIE } from "../archivist/web/auth.js";

/**
 * The Discord bot's credential for the API. The bot sends the shared service
 * token as `Authorization: Bearer <token>` and names the Discord user it acts
 * for in `X-Archivist-User`. The service trusts that name the way it trusts a
 * signed-in browser, because the bot has already seen who ran the command.
 * Owner status still comes from the service's own owner list, and every
 * archive request checks the whitelist as it does for browsers.
 */

export const ACTING_USER_HEADER = "x-archivist-user";

const BEARER = /^Bearer\s+(\S+)\s*$/i;
/** The browser session cookie, read from the raw header because cookies are parsed later. */
const SESSION_COOKIE_PATTERN = new RegExp(`(^|;\\s*)${SESSION_COOKIE}=`);
const DISCORD_ID = /^\d{17,20}$/;

function digest(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

export interface ServiceAuth {
  /** True when the request carries the bot's credential. Throws when it carries a wrong one. */
  hasCredential(request: FastifyRequest): boolean;
  /** The contributor a bot request acts for, or null when the request has no credential. */
  identify(request: FastifyRequest): Delegated | null;
  /** Refuses anyone but the bot, for routes only the bot uses. */
  requireService(request: FastifyRequest): void;
}

export function serviceAuth(options: {
  /** The shared token, or null when the bot is not allowed in. */
  token: string | null;
  ownerIds: ReadonlySet<string>;
}): ServiceAuth {
  // Comparing digests keeps the comparison constant-time whatever the lengths.
  const expected = options.token === null ? null : digest(options.token);

  function hasCredential(request: FastifyRequest): boolean {
    const header = request.headers.authorization;
    if (typeof header !== "string") return false;
    const match = BEARER.exec(header);
    // Another scheme, such as a reverse proxy's Basic sign-in, is not meant for this service.
    if (!match) return false;
    // A request is either the bot's or a browser's. One carrying both is refused rather than guessed.
    if (SESSION_COOKIE_PATTERN.test(request.headers.cookie ?? "")) {
      throw new ArchivistError(
        "invalid_input",
        "Send either the service credential or a browser session, not both.",
        { reason: "mixed_credentials" },
      );
    }
    if (expected === null || !timingSafeEqual(digest(match[1]!), expected)) {
      throw new ArchivistError("no_session", "That service credential is not valid.", {
        reason: "invalid_service_token",
      });
    }
    return true;
  }

  function identify(request: FastifyRequest): Delegated | null {
    if (!hasCredential(request)) return null;
    const header = request.headers[ACTING_USER_HEADER];
    const userId = typeof header === "string" ? header.trim() : "";
    if (!DISCORD_ID.test(userId)) {
      throw new ArchivistError(
        "invalid_input",
        "Name the Discord user this request acts for in the X-Archivist-User header.",
        { field: ACTING_USER_HEADER, reason: "acting_user_required" },
      );
    }
    return { actor: { userId, isOwner: options.ownerIds.has(userId) }, via: "service" };
  }

  function requireService(request: FastifyRequest): void {
    if (!hasCredential(request)) {
      throw new ArchivistError("forbidden", "Only the Discord bot can use this.", {
        reason: "service_only",
      });
    }
  }

  return { hasCredential, identify, requireService };
}
