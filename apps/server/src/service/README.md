# Service

The standalone Archivist service: its settings, its entry point and command line, the Discord bot's credential and routes, and the tools for the owner's machine. It builds the website's app from [`../archivist/web/`](../archivist/web/README.md) and adds what only a separate service needs.

| File | Contents |
| --- | --- |
| `main.ts` | The command line: `serve`, `view`, `import-bot-state`, and `healthcheck` |
| `config.ts` | Settings from environment variables, the only place that reads them, and the checks `serve` runs before starting |
| `server.ts` | Builds the service's app and runs it: the operational database, routine cleanup, the listener, and shutdown |
| `service-auth.ts` | The bot's credential: the bearer service token and the `X-Archivist-User` it acts for |
| `bot-routes.ts` | Routes the Discord commands need beyond the website's: the remembered archive, lookups for autocomplete, summaries, and deletion checks |
| `admin-routes.ts` | Owner administration: archives, whitelists, and exports |
| `announcement-routes.ts` | The bot's side of upload announcements: claiming queued posts, their previews, and reporting how each post went |
| `viewer.ts` | The local viewer, which opens archive folders read-only without sign-in |
| `import-bot-state.ts` | The one-time import of Archivist's operational rows from the bot's `guhbot.db` |

## Behavior

* **Settings.** `serve` refuses to start without the Discord sign-in settings, a session secret of at least 32 bytes, and at least one owner in `ARCHIVIST_OWNER_IDS`. A service token shorter than 32 bytes is refused. Without a token, the bot's routes refuse every request and the website works as usual.
* **Owners.** Owner status comes only from `ARCHIVIST_OWNER_IDS`, read at start and applied to every request, including sessions that already exist.
* **The bot's requests.** The [Bot API](../../../../docs/design/bot-api.md) is the contract. A request with the right token acts for the Discord user it names, with that user's access. A wrong token is refused and never falls back to a cookie, and a request that carries both the token and a session cookie is refused.
* **Announcements.** Creating an artifact queues its announcement through the archive mutation's journal, so a crash between saving the artifact and queueing the post is repaired before the next change. The queue keeps a snapshot of the artifact as submitted. A claim not reported within ten minutes becomes indeterminate and is never handed out again.
* **Routine work.** At start and every minute, the service removes abandoned upload folders and settles expired claims. At start it also marks exports a restart interrupted as failed.
* **The operational database.** `operational.db` in the data directory, in WAL mode. It never goes into an export.
* **The local viewer.** Copies each archive's database into a temporary folder, migrates the copy if it is older, links the media folder, and refuses every change except the viewer's own preferences. The folders it opens are never written.

## Tests

`npm run test:service` runs [`tests/service/`](../../tests/README.md) against the whole service app.
