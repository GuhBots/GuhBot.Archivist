# GuhBot Archivist

Archivist preserves the history of a Discord community: original photos, videos, and audio, the people in them, and the events they show, in independent archives that can be exported and opened without GuhBot. This repository is the Archivist service. It holds the archives, their media, and their rules, and serves the website people use to add, edit, and research them.

The [GuhBot Discord bot](https://github.com/GuhBots/GuhBot.Discord) offers quick Archivist commands, such as adding an artifact from Discord, by calling this service's API. The two run as separate services, possibly on different machines. The [Archivist plan](https://github.com/GuhBots/GuhBot.Discord/blob/feat/archivist/docs/proposals/ARCHIVIST-PLAN.md) specifies the product.

## Start Here

* **Running Archivist on a server:** Follow [Self-Hosting](docs/guides/self-hosting.md), including putting it on your own domain with a Cloudflare Tunnel.
* **Connecting the Discord bot:** Follow [Connecting the Bot](docs/guides/connecting-the-bot.md). [Bot API](docs/design/bot-api.md) is the contract between the two.
* **Moving archives out of the bot:** Follow [Moving From the Bot](docs/guides/moving-from-the-bot.md).
* **Setting up development:** Follow [Dev Container](.devcontainer/README.md), then [Development](#development) below.
* **Contributing:** Read [Contributing](CONTRIBUTING.md), [Coding Style](docs/coding-style.md), and [Documentation](docs/documentation.md). AI assistants also read [AGENTS.md](AGENTS.md).

## Layout

The repository is an npm workspaces monorepo.

```text
.
├── apps/
│   ├── server/        The service: archive storage and rules, sign-in, the JSON API, and the command line
│   └── web/           The website's pages, built with React, Vite, and Tailwind
├── docs/              Conventions, guides, and the bot API design
├── tools/             Repository checks
├── Dockerfile         Development, build, and runtime images
├── compose.yaml       How servers run the service, with an optional Cloudflare Tunnel
└── .env.example       Every setting, with placeholders
```

[`apps/server`](apps/server/README.md) and [`apps/web`](apps/web/README.md) describe their own layouts.

## How It Fits Together

```text
Browser ──HTTPS──► Archivist service ◄──HTTPS + service token── GuhBot Discord bot
                   (website + API)                               (Archivist commands,
                   /data: archives, media,                        upload announcements)
                   operational.db
```

* People sign in to the website with Discord. Only owners, listed in `ARCHIVIST_OWNER_IDS`, and Discord users on at least one archive's whitelist get in.
* The bot sends a shared service token and the Discord user who ran each command. The service checks that user's access exactly as it checks a browser's.
* New artifacts queue an announcement. The bot collects the queue and posts each one in the archive's logs channel.
* Only the service writes archives. The bot keeps no archive data.

## Development

Run these from the repository root, inside the dev container or with Node.js 22.12 or newer.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the workspaces' dependencies |
| `npm run build` | Compile the server to `apps/server/build/` and build the website to `apps/web/dist/` |
| `npm start` | Run the service with the settings in `.env` |
| `npm run check` | Type check the workspaces and tests, and check formatting |
| `npm test` | Run every server test suite |
| `npm run test:core`, `test:web`, `test:service` | Run one suite: archive rules, website routes, or the standalone service and bot API |
| `npm run import-bot-state -- <guhbot.db>` | Copy Archivist's registry, whitelists, and preferences from the bot's database, as [Moving From the Bot](docs/guides/moving-from-the-bot.md) describes |
| `npm run view -- <folder>` | Open archive folders read-only in a website on this computer, as [Viewing Archives Locally](#viewing-archives-locally) describes |
| `python3 tools/scripts/run_checks.py` | Check Markdown acronyms, links, and whitespace, as [Tools](tools/README.md) describes |

To run the service locally, copy `.env.example` to `.env` and fill in the Discord sign-in application, a session secret, and your own Discord user ID as the owner. Register `http://localhost:3000/auth/discord/callback` as a redirect in the Discord application. Then run `npm run build` and `npm start`, and open `http://localhost:3000`.

## Viewing Archives Locally

`npm run view -- <folder>` opens one or more archive folders, such as an unzipped export, in a website at `http://localhost:3001`, with no sign-in, settings, or Discord. It copies each archive's database to a temporary folder, reads media in place, and refuses every change, so the folders stay exactly as they were. Pass `--port` to use another port. Unzip an export first and open the folder it makes.

## Image and Releases

The [Dockerfile](Dockerfile) has three stages. The `dev` stage is the dev container, the `build` stage builds both workspaces, and the `runtime` stage is the image servers run. The [publish workflow](.github/workflows/publish.yml) publishes it to the GitHub container registry, as [Releasing](docs/guides/releasing.md) describes. To run the service locally exactly as a server would, copy `.env.example` to `.env` and run `docker compose up -d --build`.

## Included Checks

Pull requests run the repository checks in [Tools](tools/README.md), type checking and formatting, a build, and the server's test suites, as [checks.yml](.github/workflows/checks.yml) defines.
