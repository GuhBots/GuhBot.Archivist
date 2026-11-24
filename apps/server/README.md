# Archivist Server

The Archivist service's server side: archive storage and rules, and the website's sign-in, JSON routes, and media streaming. It is a workspace of the repository's npm monorepo.

## Layout

| Path | Contents |
| --- | --- |
| `src/archivist/` | Archive storage and rules, described in its [README](src/archivist/README.md) |
| `src/archivist/web/` | The website's server side, described in its [README](src/archivist/web/README.md) |
| `src/service/` | The standalone service: settings, the command line, the bot's credential and routes, the local viewer, and the import from the bot, described in its [README](src/service/README.md) |
| `tests/` | Automated tests, described in [Tests](tests/README.md) |

The website's pages are a separate workspace, [`apps/web`](../web/README.md), which this server serves once built.

## Commands

Run these from the repository root. They work the same inside the [dev container](../../.devcontainer/README.md).

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile the TypeScript in `src/` to `build/`, then build the website |
| `npm start` | Run the service with the settings in `.env` |
| `npm run check` | Type check the source and tests, and check formatting |
| `npm test` | Compile and run every test suite |

`node apps/server/build/service/main.js help` lists the command line's commands.

The archive code came from GuhBot.Discord, where Archivist first ran inside the bot. The bot now calls this service instead and keeps no copy.
