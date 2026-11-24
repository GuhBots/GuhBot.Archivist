# Images for developing and running the Archivist service.
#
#   dev      The shared development environment. The dev container uses it.
#   build    Builds the server and the website with the dev stage's tools.
#   runtime  The image published for servers. It contains only what the
#            service needs to run.
#
# See .devcontainer/README.md and docs/guides/self-hosting.md.

ARG UBUNTU_VERSION=26.04
ARG NODE_VERSION=24.22.3

# The official Node.js image supplies the node binary for the dev and runtime
# stages, so both use the same pinned version.
FROM node:${NODE_VERSION}-bookworm-slim AS node

# ---------------------------------------------------------------------------
# dev
# ---------------------------------------------------------------------------
FROM ubuntu:${UBUNTU_VERSION} AS dev

ARG USERNAME=dev

ENV LANG=C.UTF-8

# General tools for working in any repository. Python 3 runs the repository
# checks in tools/scripts/.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash-completion \
        ca-certificates \
        curl \
        git \
        less \
        nano \
        openssh-client \
        python3 \
        sudo \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# A C++ toolchain lets npm compile native modules, such as better-sqlite3,
# when it does not use a prebuilt binary. Perl runs ExifTool, which reads
# photo and video metadata, in the tests as in the runtime image.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential \
        perl \
    && rm -rf /var/lib/apt/lists/*

# Node.js and npm build and run the service. Bump NODE_VERSION above to upgrade.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Ubuntu images include a user named ubuntu with ID 1000, the usual ID of the
# first user on a Linux host. Rename it so the container user owns files in
# the mounted workspace the same way the host user does. The user can run sudo
# without a password, to try out packages before adding them to this file.
RUN usermod --login "${USERNAME}" --move-home --home "/home/${USERNAME}" ubuntu \
    && groupmod --new-name "${USERNAME}" ubuntu \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/${USERNAME}" \
    && chmod 0440 "/etc/sudoers.d/${USERNAME}"

USER ${USERNAME}

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
FROM dev AS build

WORKDIR /home/dev/src

# Install dependencies before copying the source, so that source changes
# reuse the cached install. npm needs every workspace's package.json.
COPY --chown=dev:dev package.json package-lock.json ./
COPY --chown=dev:dev apps/server/package.json apps/server/
COPY --chown=dev:dev apps/web/package.json apps/web/
RUN npm ci

# Compile the server and build the website, then keep only what the service
# needs at run time, in the same layout: the server finds the website at
# apps/web/dist, and node_modules links each workspace by a relative path.
COPY --chown=dev:dev . .
RUN npm run build \
    && npm prune --omit=dev \
    && mkdir -p out/apps/server out/apps/web \
    && cp -r package.json node_modules out/ \
    && cp -r apps/server/package.json apps/server/build out/apps/server/ \
    && cp -r apps/web/package.json apps/web/dist out/apps/web/

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
# Use the same base as the dev stage, so that programs built there run here.
FROM ubuntu:${UBUNTU_VERSION} AS runtime

# Install only what the service needs at run time. CA certificates let it
# make HTTPS connections to Discord and Google. Perl runs ExifTool. The base
# image's minimal Perl lacks modules ExifTool needs for dates, text
# encodings, and compressed metadata.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        perl \
    && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user. /data holds the archives and the operational
# database, and compose.yaml mounts a volume there.
RUN useradd --system --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin app \
    && mkdir -p /app /data \
    && chown app:app /data

WORKDIR /app

COPY --from=build /home/dev/src/out/ /app/

USER app

# A container must listen on 0.0.0.0 for its published port to reach it.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    ARCHIVIST_HOST=0.0.0.0 \
    ARCHIVIST_PORT=3000

EXPOSE 3000

# Asks the running service for /api/health on this machine.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD ["node", "apps/server/build/service/main.js", "healthcheck"]

CMD ["node", "apps/server/build/service/main.js", "serve"]
