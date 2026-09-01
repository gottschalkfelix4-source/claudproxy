# syntax=docker/dockerfile:1

# Debian rather than Alpine: the Claude Agent SDK ships a glibc binary for
# linux-x64/arm64, and node:sqlite needs no native build step here.
FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ------------------------------------------------------------------ #

FROM node:24-bookworm-slim AS runtime

# ca-certificates for TLS to api.anthropic.com; tini to reap the harness
# subprocesses the Claude Code engine spawns.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini curl \
 && rm -rf /var/lib/apt/lists/*

# Stamped in by CI so a running container can name its own build — telling an
# up-to-date container from a stale one should not require comparing digests.
ARG APP_VERSION=dev
ARG GIT_SHA=""
ARG BUILD_TIME=""

ENV APP_VERSION=$APP_VERSION \
    GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME \
    NODE_ENV=production \
    DATA_DIR=/data \
    WORK_DIR=/tmp/claude-proxy-work \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

# Runtime dependencies only. Installing inside the image (rather than copying
# node_modules from the host) is what pulls the correct platform binary for the
# Claude Agent SDK.
#
# --chown here, rather than a later `chown -R /app`, keeps the ~250 MB of
# node_modules in a single layer instead of duplicating it.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# That platform package *is* the full Claude Code CLI, so linking it gives us
# `docker compose exec claude-proxy claude setup-token` for free — installing
# @anthropic-ai/claude-code separately would add another ~200 MB of the same
# binary.
RUN set -eu; \
    claude_bin="$(find /app/node_modules/@anthropic-ai -maxdepth 2 -name claude -type f -perm -u+x | head -n1)"; \
    test -n "$claude_bin"; \
    ln -sf "$claude_bin" /usr/local/bin/claude; \
    claude --version

COPY --from=build --chown=node:node /app/dist ./dist

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data /home/node/.claude /tmp/claude-proxy-work \
 && chown -R node:node /data /home/node /tmp/claude-proxy-work

# Stays root so the entrypoint can align volume ownership with PUID/PGID before
# dropping privileges. Unraid mounts appdata as 99:100; plain Docker hosts
# usually want 1000:1000. Passing --user to docker run skips the whole dance.
ENV PUID=1000 \
    PGID=1000

EXPOSE 3000
VOLUME ["/data", "/home/node/.claude"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
