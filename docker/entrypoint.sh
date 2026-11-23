#!/bin/sh
set -e

# YouTube changes often; a fresh yt-dlp fixes most download errors.
if [ "${ENCORE_UPDATE_YTDLP:-true}" = "true" ]; then
  echo "Updating yt-dlp..."
  pip install -q -U "yt-dlp[default]" 2>&1 | tail -n 2 || echo "yt-dlp update failed, using the bundled version"
fi

mkdir -p /config /library

CMD="uvicorn encore.main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips=*"

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  chown "$PUID:$PGID" /config /library
  [ -d /config/models ] || install -d -o "$PUID" -g "$PGID" /config/models
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups $CMD
fi
exec $CMD
