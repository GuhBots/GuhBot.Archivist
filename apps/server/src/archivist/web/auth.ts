import type {} from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isAdmitted } from "../access.js";
import type { Actor, ArchivistContext } from "../context.js";
import { ArchivistError } from "../errors.js";
import {
  getDateOrder,
  getTimeZone,
  resetPreferences,
  setDateOrder,
  setTimeZone,
} from "../preferences.js";
import {
  authorizeUrl,
  exchangeCode,
  type Fetch,
  fetchIdentity,
  type OAuthSettings,
  revokeToken,
} from "./discord-oauth.js";
import {
  AUTH_STATE_LIFETIME_MS,
  consumeAuthState,
  createAuthState,
  createSession,
  deleteSession,
  ownerCheckDue,
  readSession,
  recordOwnerCheck,
  type Session,
  SESSION_LIFETIME_MS,
} from "./sessions.js";

/**
 * Discord sign-in, sign-out, and the signed-in contributor's own settings.
 * Routes elsewhere call `requireActor` to find who is asking: a browser
 * signed in with Discord, or the Discord bot with its service credential.
 */

export const SESSION_COOKIE = "archivist_session";
const STATE_COOKIE = "archivist_signin";

/** How a request proved who it acts for. */
export type Via = "session" | "service";

/** A request identified without a session cookie, such as by the bot's service credential. */
export interface Delegated {
  actor: Actor;
  via: Exclude<Via, "session">;
  /** A name to show for the contributor, when the identifier knows one. */
  name?: string;
}

export interface Identified {
  actor: Actor;
  /** The browser session, when the contributor signed in with Discord. */
  session: Session | null;
  via: Via;
  /** A name the identifier gave, for requests without a session. */
  name?: string;
}

export interface AuthOptions {
  context: ArchivistContext;
  /** Discord sign-in. Without it, the sign-in routes are not offered. */
  oauth?: OAuthSettings;
  /** The path the website lives under, or an empty string. */
  basePath: string;
  /** Cookies are marked Secure when the website uses HTTPS. */
  secure: boolean;
  /** Whether a Discord user is one of the owners. */
  isOwner(userId: string): Promise<boolean>;
  /**
   * How long a session's owner status is trusted before `isOwner` is asked
   * again. Zero asks on every request, for an owner list that costs nothing
   * to read.
   */
  ownerRecheckMs?: number;
  fetch: Fetch;
  logError(message: string, error: unknown): void;
  /**
   * Identifies a request before its session cookie is read. Returns null to
   * fall back to the cookie, and throws to refuse the request.
   */
  identify?(request: FastifyRequest): Delegated | null;
  /** Optional abilities the website shows controls for, such as Discord lookups. */
  features?: { discordLookups: boolean };
}

export interface Auth {
  register(scope: FastifyInstance): void;
  /** Who is asking. A signed-in contributor's owner status is at most five minutes old. */
  requireActor(request: FastifyRequest): Promise<Identified>;
}

function noSession(): ArchivistError {
  return new ArchivistError("no_session", "Sign in with Discord first.");
}

function notAdmitted(): ArchivistError {
  return new ArchivistError(
    "forbidden",
    "Your Discord account is not on any archive's whitelist. Ask the archive's owner to add you.",
    { reason: "not_admitted" },
  );
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function createAuth(options: AuthOptions): Auth {
  const { context } = options;
  const cookiePath = options.basePath || "/";
  const home = `${options.basePath}/`;

  function sessionToken(request: FastifyRequest): string | null {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const unsigned = request.unsignCookie(raw);
    return unsigned.valid && unsigned.value ? unsigned.value : null;
  }

  async function requireActor(request: FastifyRequest): Promise<Identified> {
    const delegated = options.identify?.(request);
    if (delegated) return { ...delegated, session: null };
    const token = sessionToken(request);
    if (!token) throw noSession();
    let session = readSession(context, token);
    if (!session) throw noSession();
    if (ownerCheckDue(context, session, options.ownerRecheckMs)) {
      try {
        session = recordOwnerCheck(context, session, await options.isOwner(session.userId));
      } catch (error) {
        // Keep the last known status and ask again on the next request.
        options.logError("Could not check owner status", error);
      }
    }
    const actor = { userId: session.userId, isOwner: session.isOwner };
    // Losing the last whitelist entry ends the session on its next request.
    if (!isAdmitted(context, actor)) {
      deleteSession(context, token);
      throw notAdmitted();
    }
    return { actor, session, via: "session" };
  }

  function preferences(actor: Actor) {
    return { timeZone: getTimeZone(context, actor), dateOrder: getDateOrder(context, actor) };
  }

  function signInPage(
    reply: FastifyReply,
    status: number,
    message: string,
    title = "Sign-in failed",
  ) {
    return reply
      .status(status)
      .type("text/html")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>` +
          `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e1f22;color:#f2f3f5;font:16px/1.5 monospace}main{max-width:36rem;padding:24px}a{color:#c9cdfb}</style></head>` +
          `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(`${options.basePath}/auth/discord`)}">Sign in again</a></p></main></body></html>`,
      );
  }

  function register(scope: FastifyInstance) {
    if (options.oauth) registerSignIn(scope, options.oauth);

    scope.post("/auth/logout", async (request, reply) => {
      const token = sessionToken(request);
      if (token) deleteSession(context, token);
      reply.clearCookie(SESSION_COOKIE, { path: cookiePath });
      return reply.status(204).send();
    });

    scope.get("/api/me", async (request) => {
      const { actor, session, via, name } = await requireActor(request);
      return {
        user: {
          id: actor.userId,
          name: session?.displayName ?? name ?? null,
          avatarUrl: session?.avatarUrl ?? null,
        },
        isOwner: actor.isOwner,
        via,
        sessionExpires: session ? new Date(session.expiresMs).toISOString() : null,
        preferences: preferences(actor),
        features: options.features ?? { discordLookups: false },
      };
    });

    scope.put<{ Body: { timeZone?: unknown } | null }>("/api/me/timezone", async (request) => {
      const { actor } = await requireActor(request);
      setTimeZone(context, actor, request.body?.timeZone);
      return preferences(actor);
    });

    scope.put<{ Body: { dateOrder?: unknown } | null }>("/api/me/date-order", async (request) => {
      const { actor } = await requireActor(request);
      setDateOrder(context, actor, request.body?.dateOrder);
      return preferences(actor);
    });

    scope.delete("/api/me/preferences", async (request) => {
      const { actor } = await requireActor(request);
      resetPreferences(context, actor);
      return preferences(actor);
    });
  }

  function registerSignIn(scope: FastifyInstance, oauth: OAuthSettings) {
    scope.get("/auth/discord", async (_request, reply) => {
      const state = createAuthState(context);
      reply.setCookie(STATE_COOKIE, state, {
        signed: true,
        httpOnly: true,
        sameSite: "lax",
        secure: options.secure,
        path: `${options.basePath}/auth`,
        maxAge: AUTH_STATE_LIFETIME_MS / 1000,
      });
      return reply.redirect(authorizeUrl(oauth, state));
    });

    scope.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
      "/auth/discord/callback",
      async (request, reply) => {
        const { code, state, error } = request.query;
        const raw = request.cookies[STATE_COOKIE];
        const remembered = raw ? request.unsignCookie(raw) : null;
        reply.clearCookie(STATE_COOKIE, { path: `${options.basePath}/auth` });
        // The state must match this browser's cookie and an unused record, so a
        // sign-in cannot be started on someone else's behalf or replayed.
        const stateOk =
          typeof state === "string" &&
          remembered?.valid === true &&
          remembered.value === state &&
          consumeAuthState(context, state);
        if (error) return signInPage(reply, 400, "Discord sign-in was cancelled.");
        if (!stateOk || typeof code !== "string" || !code) {
          return signInPage(reply, 400, "That sign-in expired or was started somewhere else.");
        }
        try {
          const accessToken = await exchangeCode(oauth, code, options.fetch);
          const identity = await fetchIdentity(accessToken, options.fetch).finally(() =>
            revokeToken(oauth, accessToken, options.fetch),
          );
          let isOwner = false;
          try {
            isOwner = await options.isOwner(identity.id);
          } catch (ownerError) {
            options.logError("Could not check owner status at sign-in", ownerError);
          }
          // Only owners and whitelisted contributors get a session. Anyone else sees why.
          if (!isAdmitted(context, { userId: identity.id, isOwner })) {
            return signInPage(
              reply,
              403,
              `${identity.name}, your Discord account is not on any archive's whitelist. Ask the archive's owner to add you, then sign in again.`,
              "No access yet",
            );
          }
          const token = createSession(context, {
            userId: identity.id,
            isOwner,
            displayName: identity.name,
            avatarUrl: identity.avatarUrl,
          });
          reply.setCookie(SESSION_COOKIE, token, {
            signed: true,
            httpOnly: true,
            sameSite: "lax",
            secure: options.secure,
            path: cookiePath,
            maxAge: SESSION_LIFETIME_MS / 1000,
          });
          return reply.redirect(home);
        } catch (failure) {
          if (failure instanceof ArchivistError)
            return signInPage(reply, failure.status, failure.message);
          throw failure;
        }
      },
    );
  }

  return { register, requireActor };
}
