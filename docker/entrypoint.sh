#!/bin/sh
set -e

# YouTube changes often; a fresh yt-dlp fixes most download errors.
# Without internet (e.g. a party offline) this is skipped within a few seconds.
online() {
  timeout 4 python -c "import socket; socket.create_connection(('pypi.org', 443), 3).close()" >/dev/null 2>&1
}

if [ "${ENCORE_UPDATE_YTDLP:-true}" = "true" ]; then
  if online; then
    echo "Updating yt-dlp..."
    timeout 120 pip install -q -U --timeout 10 --retries 1 "yt-dlp[default]" 2>&1 | tail -n 2 \
      || echo "yt-dlp update failed, using the installed version"
  else
    echo "No internet connection, skipping the yt-dlp update (library songs still work offline)"
  fi
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
