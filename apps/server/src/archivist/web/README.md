# Archivist Website

The website's server side: sign-in, the JSON routes, media, and the built pages. The service in [`src/service/`](../../service/README.md) builds this app, adds the Discord bot's routes, and runs it. The pages are built separately from [`apps/web`](../../../../web/README.md), and this server serves them.

| File | Contents |
| --- | --- |
| `settings.ts` | The listener's settings and the check that runs when the owner starts it |
| `listener.ts` | The single listener: start, stop, status, and port-conflict reporting |
| `app.ts` | The HTTP app: the base path, error replies, security headers, the same-origin check, and the built frontend |
| `auth.ts` | Discord sign-in and sign-out, the signed-in contributor (`requireActor`), and `/api/me` with its preferences |
| `sessions.ts` | Sessions and sign-in states in the operational database, stored as token hashes |
| `read-routes.ts` | Read routes under `/api/archives`: archives, places, artifacts, events, entities, requests, the board, and search |
| `change-routes.ts` | Routes that change an archive: entities and their history, merge, artifacts, events, requests and their buckets, the board, and the date preview |
| `intake-routes.ts` | Adding artifacts from the website or the bot (upload, Discord attachment, or Drive link), duplicate review, entity picture uploads, and the logs channel |
| `media-routes.ts` | Media originals and previews, with byte ranges, and the edit-log download |
| `reviews.ts` | Duplicate reviews waiting for the contributor's choices, in memory for 15 minutes |
| `view-routes.ts` | The timeline, calendar, heatmap, and graph data |
| `discord-oauth.ts` | Discord's OAuth endpoints over plain HTTPS: the sign-in link, code exchange, identity, and token revocation |

The service passes in what this app cannot decide by itself: who the owners are, how a request carrying the bot's service credential names its contributor, and, in the local viewer, a fixed local contributor in place of Discord sign-in. A browser cannot set the logs channel, because only the bot can check a Discord channel's permissions.

## Behavior

* **One listener.** The service starts one listener and stops it on shutdown. Starts and stops run one at a time.
* **Failures.** Missing settings, a busy port, or an address the machine does not have stop the service with a message naming the problem.
* **Stopping.** Requests in progress finish before the listener closes, and then the archives close.
* **Errors.** Every error reply is `{code, message, details}` with the status from `src/archivist/errors.ts`. An unexpected failure is logged by the service and replies `500` with code `internal_error` and a generic message, never its details.
* **Sign-in.** `/auth/discord` sends the browser to Discord with a one-time state that must come back to the same browser within ten minutes. The callback exchanges the code, reads who signed in, revokes Discord's token, and sets a signed, HttpOnly session cookie that lasts seven days from sign-in. Only owners and Discord users on at least one archive's whitelist get a session. Anyone else sees a page saying they have no access yet, and a session whose user loses their last whitelist entry ends on its next request. Owner status is asked again after `ownerRecheckMs`, which the service sets to every request. `POST /auth/logout` ends the session.
* **Changes.** Requests other than `GET`, `HEAD`, and `OPTIONS` must carry the website's own Origin, so another site cannot make changes on someone's behalf. Requests with the bot's service credential carry no cookie, so they skip this check.
* **Uploads.** Fields come before the file, and a field after it is refused. Only the bot may mark an upload as a Discord attachment or say where in Discord it was submitted. A new artifact's announcement is queued for the bot, and the reply says whether it was.
* **Base path.** Everything lives under the path of `ARCHIVIST_BASE_URL`, such as `/archivist`, including cookies and the sign-in callback.
* **Independence.** Nothing here imports a Discord library or reads the environment. A core test enforces it.
* **Pages.** Files in the built frontend are served as they are. A missing file is a `404`, and every other page gets its `index.html` with a `<base>` tag for the base path, the single-page app. Until the frontend is built, pages show a short notice.

## Tests

`npm run test:web` runs the listener on a free local port. See [Tests](../../../tests/README.md).
