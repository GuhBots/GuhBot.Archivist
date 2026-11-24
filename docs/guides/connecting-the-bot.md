# Connecting the Bot

The GuhBot Discord bot's Archivist commands are clients of this service. This guide gives the bot its credential and address, and explains how to change or revoke them. [Bot API](../design/bot-api.md) describes what the bot sends.

## Prerequisites

* Archivist running as [Self-Hosting](self-hosting.md) describes, with your Discord user ID in `ARCHIVIST_OWNER_IDS`.
* The bot's `.env` on the machine that runs the bot. Its own setup guide lists its other settings.
* `openssl`, or another way to make 32 random bytes, on any trusted machine.

## The Service Token

The bot proves it is the bot with one shared secret, the service token. Both services hold the same value as `ARCHIVIST_SERVICE_TOKEN`. It is separate from every other secret: it is not the bot's Discord token, the Discord application's client secret, or Archivist's session secret.

The token lets the bot act for any Discord user who runs a command. Archivist still checks that user's owner status and whitelist on every request, so the token never makes anyone an owner or opens an archive they cannot see. Treat it like a password for the whole archive service.

### Set It Up

1. Generate a token.

   ```sh
   openssl rand -hex 32
   ```

2. In Archivist's `.env`, set `ARCHIVIST_SERVICE_TOKEN` to that value, then restart Archivist with `docker compose up -d`.
3. In the bot's `.env`, set the same `ARCHIVIST_SERVICE_TOKEN`, and set `ARCHIVIST_API_URL` to Archivist's address, as [Choosing the Address](#choosing-the-address) explains.
4. Restart the bot.
5. In Discord, run `/archivist-admin status` in the owner server. It reports whether the bot reached Archivist and whether you are one of its owners.

Keep the token out of Git, chat, screenshots, and issue reports. `chmod 600 .env` keeps other users on the machine from reading it.

### Change It

Change the token if it may have leaked, or whenever you like.

1. Generate a new token.
2. Put it in Archivist's `.env` and restart Archivist. From this moment the old token stops working, and the bot's Archivist commands fail until step 3. Signed-in browsers are unaffected.
3. Put it in the bot's `.env` and restart the bot.

### Turn the Bot Off

Remove `ARCHIVIST_SERVICE_TOKEN` from Archivist's `.env` and restart Archivist. The website keeps working, and the bot's Archivist commands report that Archivist refused them. To turn the commands off in Discord as well, remove `archivist` from the bot's `MODULES`, or remove every server with `/archivist-admin server remove`.

## Choosing the Address

`ARCHIVIST_API_URL` is Archivist's base address as the bot reaches it, including any path the website lives under.

| Where the bot runs | `ARCHIVIST_API_URL` |
| --- | --- |
| Another machine | The public address, the same as Archivist's `ARCHIVIST_BASE_URL`, such as `https://guhbot.example.com/archivist`. Always HTTPS |
| The same machine | The loopback address Archivist publishes, such as `http://127.0.0.1:3000`, when the bot runs outside a container. Add the path when `ARCHIVIST_BASE_URL` has one |
| Another container on the same machine | `http://archivist:3000` over the shared network that `compose.local.yaml` sets up, as [Trying Both on One Machine](#trying-both-on-one-machine) describes, with the path when there is one |

A private address avoids the Cloudflare upload limit described in [Self-Hosting](self-hosting.md#your-own-domain-with-cloudflare-tunnel), because the bot's uploads then never pass through Cloudflare. A private network does not replace the token: the bot sends it either way.

The bot refuses to follow redirects, so the address must be exact. If `/archivist-admin status` reports a redirect, the address is missing its path or uses `http` where Cloudflare redirects to `https`.

## Trying Both on One Machine

To run the service and the bot as two separate containers on one computer, such as a laptop, put them on a shared Docker network. Each repository has a `compose.local.yaml` that joins the network named `guhbot`, where the bot finds Archivist under the name `archivist`. Each still has its own data volume.

1. Create the network once.

   ```sh
   docker network create guhbot
   ```

2. In both repositories' `.env`, load the local file with the others.

   ```sh
   COMPOSE_FILE=compose.yaml:compose.override.yaml:compose.local.yaml
   ```

3. In the bot's `.env`, set `ARCHIVIST_API_URL=http://archivist:3000` and the same `ARCHIVIST_SERVICE_TOKEN` as Archivist's.
4. Start Archivist first, then the bot, each from its own repository.

   ```sh
   docker compose up -d --build
   ```

Browsers still use `ARCHIVIST_BASE_URL`, such as `http://localhost:3000`. Run `docker compose down` in each repository to stop them. The network stays until `docker network rm guhbot`.

## What Changes for Contributors

* The website is the main place to contribute and research. Owners whitelist contributors with `/archivist-admin whitelist add`, and those contributors sign in to the website with Discord.
* The bot's contributor commands are `/archive` and its alias `/a`. They work only in the servers owners add with `/archivist-admin server add`, and only for archives the contributor is whitelisted for. The bot keeps that server list in its own database. The whitelists stay here, because the website checks them at sign-in.
* New artifacts from either place are announced in the archive's logs channel. Set it with `/set-artifact-logs-channel` in Discord, where the bot can check its permissions. When the bot is offline, announcements wait and are posted when it returns.
* When Archivist is down, the bot's Archivist commands say so and change nothing. The rest of the bot keeps working.
