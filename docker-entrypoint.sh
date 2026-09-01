#!/bin/sh
set -e

# Drops to PUID:PGID after fixing ownership of the mounted volumes.
#
# Unraid mounts appdata as nobody:users (99:100), plain Docker hosts usually
# expect 1000:1000. Without this the container could not write its database or
# store the credentials `claude setup-token` produces.

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

DATA_DIR="${DATA_DIR:-/data}"
CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/home/node/.claude}"
WORK_DIR="${WORK_DIR:-/tmp/claude-proxy-work}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" "$CLAUDE_CONFIG_DIR" "$WORK_DIR"

  # Only touch ownership when it is actually wrong: chown -R on a large mounted
  # volume is slow, and on some remote filesystems it fails outright.
  for dir in "$DATA_DIR" "$CLAUDE_CONFIG_DIR" "$WORK_DIR"; do
    current="$(stat -c '%u:%g' "$dir" 2>/dev/null || echo "")"
    if [ "$current" != "${PUID}:${PGID}" ]; then
      chown -R "${PUID}:${PGID}" "$dir" 2>/dev/null \
        || echo "[proxy] warning: could not chown $dir — check the host permissions" >&2
    fi
  done

  # Claude Code resolves some paths from HOME.
  HOME="$(dirname "$CLAUDE_CONFIG_DIR")"
  export HOME

  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups -- "$@"
fi

# Already unprivileged (e.g. `docker run --user`): run as-is.
exec "$@"
