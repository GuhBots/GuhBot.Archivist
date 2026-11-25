# Self-Hosting

This guide runs the Archivist service on a machine you control, such as a Raspberry Pi, a spare laptop, or a home server, and puts its website on your own domain without opening ports on your router. The steps are the same on each machine. The machine downloads the published image and runs it with Docker Compose.

The Discord bot is a separate service with its own `compose.yaml`, and may run on another machine. [Connecting the Bot](connecting-the-bot.md) links the two.

## How It Works

* **The image** contains the service and everything it needs to run. [Releasing](releasing.md) explains how GitHub Actions publishes it to the GitHub container registry (GHCR).
* **`compose.yaml`** describes how to run the image: which version, which settings, where data is kept, and to restart it automatically.
* **`.env`** holds the settings and secrets for one machine. It is never committed or built into the image.

A server needs only Docker and these two files. It does not need the source code, a programming language, or any build tools.

## Prepare the Machine

### Raspberry Pi

1. Flash **Raspberry Pi OS Lite (64-bit)** with [Raspberry Pi Imager](https://www.raspberrypi.com/software/). The 64-bit system is required, because the image is built for 64-bit ARM. In the Imager settings, set the hostname and user, and enable SSH with your public key.
2. Start the Pi and connect to it from your computer.

   ```sh
   ssh <user>@<hostname>.local
   ```

3. Install Docker, then log out and back in so your user can run it.

   ```sh
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker "$USER"
   ```

For a service that writes a lot of data, consider booting from a USB SSD instead of an SD card, which wears out under heavy writing.

### Other Machines

* **Linux server or laptop:** Install [Docker Engine](https://docs.docker.com/engine/install/) and add your user to the `docker` group as above.
* **Windows or macOS:** Install [Docker Desktop](https://docs.docker.com/get-docker/) and enable **Start Docker Desktop when you sign in**. Keep the machine from sleeping while it serves.
* **Unraid or Portainer:** See [Homelab Tools](#homelab-tools).

Docker downloads the right image for the machine's processor automatically.

## Deploy

Create a folder for the service and download its configuration.

```sh
mkdir -p ~/services/archivist && cd ~/services/archivist
curl -fsSLO https://raw.githubusercontent.com/GuhBots/GuhBot.Archivist/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/GuhBots/GuhBot.Archivist/main/.env.example -o .env
chmod 600 .env
```

Edit `.env` to set the version and fill in the settings and secrets the service needs, as [Configure Archivist](#configure-archivist) explains.

```sh
nano .env
```

`APP_VERSION` selects the image to run.

| Value | Runs | Use it for |
| --- | --- | --- |
| `1.2.3` | That exact release | Production, with deliberate updates and easy rollback |
| `latest` | The newest release | Production that follows each release |
| `main` | The newest merge to `main` | Testing changes before a release, or a personal service under active development |

Before the first release, only `main` exists.

Start the service.

```sh
docker compose up -d
```

The service now runs in the background and starts again after a crash or a restart of the machine.

## Configure Archivist

Each setting is described in `.env.example`. These need your attention before the first start.

| Setting | What to put there |
| --- | --- |
| `ARCHIVIST_BASE_URL` | The address people type, including any path, such as `https://guhbot.example.com/archivist`. Plain `http` works only for `localhost` |
| `ARCHIVIST_OWNER_IDS` | Your Discord user ID, and those of any other owners, separated by commas. Owners create archives and manage whitelists. The service refuses to start without one. In Discord, turn on Developer Mode, then right-click your name and copy your user ID |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | From the Discord application's OAuth2 page in the [Developer Portal](https://discord.com/developers/applications). It can be the bot's application or a separate one. Add `<ARCHIVIST_BASE_URL>/auth/discord/callback` under Redirects, exactly |
| `ARCHIVIST_SESSION_SECRET` | A new random value from `openssl rand -hex 32`. Changing it signs everyone out |
| `ARCHIVIST_SERVICE_TOKEN` | The Discord bot's credential, from `openssl rand -hex 32`, as [Connecting the Bot](connecting-the-bot.md) explains. Leave it empty until the bot is connected |
| `GOOGLE_DRIVE_API_KEY` | Optional. Public Drive links work without it |
| `ARCHIVIST_PUBLISH` | Where the host publishes the website's port. The default, `127.0.0.1:3000`, keeps it reachable only from the machine itself, which is all a Cloudflare Tunnel or a reverse proxy on the same machine needs |

Signing in only lets in owners and Discord users on at least one archive's whitelist. Everyone else sees that they have no access yet.

## Everyday Tasks

Run these from the service's folder.

| Task | Command |
| --- | --- |
| Start | `docker compose up -d` |
| Stop | `docker compose down` |
| Update to the version in `.env` | `docker compose up -d --pull always` |
| Apply changes to `.env` | `docker compose up -d` |
| Check status | `docker compose ps` |
| Follow the logs | `docker compose logs -f` |
| Restart | `docker compose restart` |
| Open a shell in the running container | `docker compose exec app sh` |

Without [Automatic Updates](#automatic-updates), updates are manual. To update, change `APP_VERSION` if it is pinned, then run the update command. To roll back, set `APP_VERSION` to the previous release and run the update command again. If the requested version does not exist, the command stops with an error and the running service is left alone.

To clean up old images after updates, run `docker image prune`.

## Settings and Secrets

Each setting the service needs is listed in two places in the repository. `.env.example` documents it with a placeholder, and the `environment` section of `compose.yaml` passes it into the container. On a server, Docker Compose reads the values from `.env` in the same folder, or from the variables entered in a tool such as Portainer.

* Keep secrets only on the machines that need them. `.env.example` in the repository lists the names, with placeholders.
* Use separate secrets for development and production, such as a separate test account or token on your own computer. Then nothing you run while developing can affect production.
* Restrict who can read `.env` with `chmod 600 .env`.
* Anyone who can run Docker on the machine can read the service's environment variables. Treat Docker access as administrator access.
* Share secrets with other maintainers through a password manager, never through Git or chat.

A required setting written as `${NAME:?message}` in `compose.yaml` stops the start with that message when its value is missing.

## Automatic Updates

Every merge to `main` publishes a new `main` image within a few minutes, as [Releasing](releasing.md) describes. Nothing tells the server about it, so the server checks instead. [`tools/host/update-stacks.sh`](../../tools/host/update-stacks.sh) downloads any newer image for each stack's tag and recreates only the containers whose image changed. A systemd timer runs it every five minutes, so a merge reaches the server within about ten minutes.

A stack follows whatever `APP_VERSION` its `.env` selects. With `main`, every merge is deployed. With a release number, the timer changes nothing until you change the number.

These steps are for Linux, including Raspberry Pi OS. They use a systemd user timer, which runs as your user with your Docker access and your `docker login`.

1. Download the script and the two unit files.

   ```sh
   cd ~/services
   curl -fsSLO https://raw.githubusercontent.com/GuhBots/GuhBot.Archivist/main/tools/host/update-stacks.sh
   chmod +x update-stacks.sh
   mkdir -p ~/.config/systemd/user && cd ~/.config/systemd/user
   curl -fsSLO https://raw.githubusercontent.com/GuhBots/GuhBot.Archivist/main/tools/host/guhbot-update.service
   curl -fsSLO https://raw.githubusercontent.com/GuhBots/GuhBot.Archivist/main/tools/host/guhbot-update.timer
   ```

   The service updates `~/services/archivist`, then `~/services/guhbot`. Edit its `ExecStart` line if your folders differ, or if this machine runs only one of the two.

2. Let your user's timers run without you being logged in, then turn the timer on.

   ```sh
   loginctl enable-linger "$USER"
   systemctl --user daemon-reload
   systemctl --user enable --now guhbot-update.timer
   ```

| Task | Command |
| --- | --- |
| Update now | `systemctl --user start guhbot-update` |
| See when it runs next | `systemctl --user list-timers` |
| Read what it did | `journalctl --user -u guhbot-update` |
| Pause automatic updates | `systemctl --user disable --now guhbot-update.timer` |

A failed download leaves that stack running as it was, and the next check tries again. Each service applies its own database migrations when it starts, so an update needs no other step. To stop following `main`, set `APP_VERSION` to a release number. The timer then keeps the server on that release.

## Both Services on One Machine

The Discord bot runs from its own repository and its own `compose.yaml`, on this machine or another. Each keeps its own `data` volume. Never mount Archivist's data in the bot's container: only Archivist writes archives. The bot reaches Archivist over its API with the service token, as [Connecting the Bot](connecting-the-bot.md) describes.

When both run on one server, they share a private Docker network. The bot reaches Archivist directly, and its uploads never pass through Cloudflare's upload limit. The tunnel publishes only the website.

```text
~/services
├── update-stacks.sh      Automatic Updates
├── archivist/            compose.yaml, compose.local.yaml, .env
└── guhbot/               the bot's compose.yaml, compose.local.yaml, .env
```

1. Create the shared network once.

   ```sh
   docker network create guhbot
   ```

2. Set up Archivist in `~/services/archivist` as [Deploy](#deploy) describes, and also download `compose.local.yaml`, which joins the shared network under the name `archivist`.

   ```sh
   cd ~/services/archivist
   curl -fsSLO https://raw.githubusercontent.com/GuhBots/GuhBot.Archivist/main/compose.local.yaml
   ```

3. Set up the bot in `~/services/guhbot` the same way, from the bot's repository.

   ```sh
   mkdir -p ~/services/guhbot && cd ~/services/guhbot
   curl -fsSLO https://raw.githubusercontent.com/GuhBots/GuhBot.Discord/main/compose.yaml
   curl -fsSLO https://raw.githubusercontent.com/GuhBots/GuhBot.Discord/main/compose.local.yaml
   curl -fsSL https://raw.githubusercontent.com/GuhBots/GuhBot.Discord/main/.env.example -o .env
   chmod 600 .env
   ```

4. Fill in both `.env` files. Besides each service's own settings, set these:

   | File | Setting | Value |
   | --- | --- | --- |
   | Both | `COMPOSE_FILE` | `compose.yaml:compose.local.yaml`, to join the shared network |
   | Both | `APP_VERSION` | `main` until the first release, because no `latest` image exists before it |
   | Both | `ARCHIVIST_SERVICE_TOKEN` | The same new value from `openssl rand -hex 32` |
   | Archivist | `COMPOSE_PROFILES` | `tunnel`, so every command includes the [Cloudflare Tunnel](#your-own-domain-with-cloudflare-tunnel) |
   | Archivist | `ARCHIVIST_BASE_URL` | The public address, such as `https://guhbot.example.com/archivist` |
   | Bot | `ARCHIVIST_API_URL` | `http://archivist:3000` plus the path in `ARCHIVIST_BASE_URL`, such as `http://archivist:3000/archivist` |

5. If the images are private, [log in to GHCR](#private-images) once.
6. Start Archivist, then the bot.

   ```sh
   cd ~/services/archivist && docker compose up -d
   cd ~/services/guhbot && docker compose up -d
   ```

7. In Discord, run `/archivist-admin status`. It reports whether the bot reached Archivist.

Then turn on [Automatic Updates](#automatic-updates) to follow every merge to `main`.

Run only one copy of the bot with a given Discord token. When moving a service to another machine, stop it on the old machine first. To test on your own computer while the server runs, use a separate test bot application with its own token.

## Your Own Domain With Cloudflare Tunnel

A Cloudflare Tunnel puts the website on your domain without opening or forwarding ports on your router. A small `cloudflared` container makes an outgoing connection to Cloudflare, and Cloudflare sends your visitors through it. `compose.yaml` includes one in the optional `tunnel` profile.

1. Add your domain to Cloudflare, if it is not there already.
2. In the Cloudflare dashboard, open **Networking**, then **Tunnels**, and create a tunnel with the **Cloudflared** connector. Older dashboards put **Tunnels** under **Zero Trust**, then **Networks**. Copy the tunnel's token, and put it in `.env` as `TUNNEL_TOKEN`. You do not need to run the install command Cloudflare shows: the `tunnel` container runs `cloudflared`.
3. On the tunnel's **Routes** tab, select **Add route**, then **Published application**. Older dashboards call it a **Public Hostname**. Enter your subdomain and domain, an optional path such as `archivist`, and the service `HTTP` with the address `app:3000`. Cloudflare creates the DNS record. The tunnel keeps the path, so the service sees the same addresses the browser uses.
4. Set `ARCHIVIST_BASE_URL` to the public address, such as `https://guhbot.example.com/archivist`, and add `https://guhbot.example.com/archivist/auth/discord/callback` to the Discord application's redirects.
5. Add `COMPOSE_PROFILES=tunnel` to `.env`, so that every `docker compose` command for this stack starts, updates, and stops the tunnel along with the service. Without it, add `--profile tunnel` to every command instead.
6. Start the service and the tunnel:

   ```sh
   docker compose up -d
   ```

7. Open the public address and sign in with Discord.

The tunnel only carries the website. A bot on the same machine reaches Archivist over the shared Docker network instead, as [Both Services on One Machine](#both-services-on-one-machine) describes.

### Testing on Your Own Computer Through the Tunnel

The tunnel runs wherever its container runs, so you can try the real public address from your own computer before setting up a server. Run Archivist on your computer with the steps above, and the public address reaches your computer.

A tunnel sends visitors to every place it runs. Never run one tunnel on two machines at once: each visitor would land on one machine or the other, and each machine has different archives. Use one of these instead.

* **Move it:** Test on your computer first. When the server is ready, run `docker compose down` on your computer, then start the tunnel on the server. The same token, address, and Discord redirect move with it.
* **Keep a test address:** Create a second tunnel with its own published application, such as `guhbot-test.example.com/archivist`, for your computer. Give your computer's `.env` that tunnel's token and address, and add that address's `/auth/discord/callback` to the Discord application's redirects too. Your computer then never takes the server's visitors.

Signing in works only at the address in `ARCHIVIST_BASE_URL`, so open the public address rather than `localhost` while the tunnel is in use.

Cloudflare limits the size of each request on its Free and Pro plans to about 100 MB. Archivist accepts files up to 100 MiB, so the largest files can be refused by Cloudflare before they reach the service. Check Cloudflare's current upload limit for your plan, and its terms for serving large video, before relying on the tunnel for every upload. A bot on the same machine or network can use a private address for its uploads instead, as [Connecting the Bot](connecting-the-bot.md) explains.

## Data and Backups

The service stores everything that must survive updates in the `data` volume, mounted at `/data` in the container. `docker compose down` keeps the volume. `docker compose down -v` deletes it.

| Path in `/data` | Contents |
| --- | --- |
| `archives/<archive ID>/` | Each archive: its database, edit log, and media. Each folder is complete on its own |
| `operational.db` | Registered archives, whitelists, sign-in sessions, preferences, logs channels, and announcement and export history |
| `archivist-exports/` | Zips owners export, kept until you delete them |
| `archivist-tmp/` | Uploads in progress and recovery journals |

To copy an export to this machine's folder, run `docker compose cp app:/data/archivist-exports/<file>.zip .`, then delete it from the volume when you have it.

To back up the volume to a file in the service's folder, stop the service and archive the volume with a temporary container.

```sh
docker compose down
docker compose run --rm --no-deps -u root -v "$PWD:/backup" app \
  tar czf /backup/data-backup.tar.gz -C /data .
docker compose up -d
```

To restore, stop the service, empty the volume, and extract the archive into it. Emptying the volume first removes files that were created after the backup.

```sh
docker compose down
docker compose run --rm --no-deps -u root -v "$PWD:/backup" app \
  sh -c 'find /data -mindepth 1 -delete && tar xzf /backup/data-backup.tar.gz -C /data'
docker compose up -d
```

These commands use `tar` from the runtime image. If the project switches to a minimal base image without `tar`, update them. Store backups on another machine.

To move the service to another machine, back up the volume, stop the service on the old machine, deploy it on the new machine, and restore the backup there.

## Run From Source

To run unreleased code, such as when trying a change on the Pi itself, clone the repository and build the image on the machine.

```sh
git clone https://github.com/<owner>/<repository>.git
cd <repository>
cp .env.example .env    # then fill it in
docker compose up -d --build
```

In a clone, `compose.override.yaml` adds the build settings, and Docker Compose loads it automatically. After pulling new commits, run `docker compose up -d --build` again. Building on a Raspberry Pi can be slow for compiled languages, and published images are usually faster to deploy.

A folder that contains only `compose.yaml` has no build settings, so updates there always use a published image and never build unreleased code by accident.

Do not edit files inside a running container. Containers are replaced on every update, which discards those changes. Change the code in the repository and rebuild or release it.

## Homelab Tools

A machine can run many self-hosted applications, such as a file server, a media server, and this service. Each application is a separate **stack**, with its own `compose.yaml`, its own volumes, and its own network. Stacks do not affect each other, and each one is updated or stopped on its own.

```text
server
├── reverse proxy     The only stack using ports 80 and 443
├── files/            compose.yaml
├── media/            compose.yaml
└── <repository>/     compose.yaml
```

### Portainer

[Portainer](https://www.portainer.io/) manages stacks through a web interface.

1. Open **Stacks** and select **Add stack**.
2. Choose **Repository** to read `compose.yaml` from GitHub, or **Web editor** to paste it.
3. Under **Environment variables**, add each setting from `.env.example` with its real value.
4. Deploy the stack.

To update, open the stack, select **Pull and redeploy**, and turn on re-pulling the image. To change the version, edit `APP_VERSION` in the stack's environment variables.

### Unraid

Unraid's built-in templates run one container each. For a stack with several services, install the **Docker Compose Manager** plugin from Community Applications, create a stack, paste `compose.yaml`, and enter the settings in the stack's environment file. Alternatively, run Portainer on Unraid and follow the steps above.

### Reverse Proxy

When more than one stack serves a website, run a reverse proxy, such as [Caddy](https://caddyserver.com/) or [Nginx Proxy Manager](https://nginxproxymanager.com/), as its own stack. It receives all web traffic on ports 80 and 443 and forwards each request by hostname, for example `bot.home.example` to this service. It can also provide HTTPS. The service then joins the proxy's network instead of publishing its own port. Document the chosen approach in the project's README.

## Private Images

Images are public by default in this template, so servers need no login. If the package is private, as GuhBot's packages are until an owner makes them public, create a GitHub personal access token with only the `read:packages` scope and log in once on each server.

```sh
docker login ghcr.io -u <github-username>
```

Paste the token when asked for a password. In Portainer, add the registry under **Registries** instead.

## Remote Access

By default the website's port is published on the machine's loopback address only, so nothing outside the machine can reach it directly. Reach it from outside through the [Cloudflare Tunnel](#your-own-domain-with-cloudflare-tunnel) or a [reverse proxy](#reverse-proxy) that provides HTTPS. To use it only on your local network, set `ARCHIVIST_PUBLISH` to `0.0.0.0:3000` and `ARCHIVIST_BASE_URL` to `http://localhost:3000` on the same machine. Discord sign-in needs HTTPS for any other address.

## Troubleshooting

* **Discord says the redirect is invalid:** The Discord application's redirect must equal `<ARCHIVIST_BASE_URL>/auth/discord/callback` exactly, including the path and `https`.
* **"No access yet" after signing in:** The Discord account is not an owner and is on no archive's whitelist. An owner adds it with `/archivist-admin whitelist add` in Discord.
* **The service stops at start with a settings message:** It names the missing or wrong setting, such as `ARCHIVIST_OWNER_IDS` or a session secret shorter than 32 bytes.
* **Large uploads fail with 413 behind the tunnel:** Cloudflare refused the request. See [Your Own Domain With Cloudflare Tunnel](#your-own-domain-with-cloudflare-tunnel).

* **`exec format error`:** The image does not match the machine's processor. On a Raspberry Pi, check that the system is 64-bit with `uname -m`, which should print `aarch64`.
* **`denied` or `unauthorized` when pulling:** The package is private, the image name in `compose.yaml` is wrong, or nothing has been published yet. See [Private Images](#private-images).
* **`manifest unknown`:** The tag in `APP_VERSION` has not been published. Use `main` before the first release.
* **`required variable ... is missing a value`:** Add the named setting to `.env`, or to the stack's environment variables in Portainer or Unraid.
* **The service keeps restarting:** Read the reason with `docker compose logs`. A missing or wrong setting is the most common cause.
