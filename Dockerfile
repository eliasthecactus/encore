# syntax=docker/dockerfile:1.7

# ---- web app ----------------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build   # writes to /src/backend/encore/static

# ---- runtime ----------------------------------------------------------------
FROM python:3.12-slim

# cpu (default) or a CUDA wheel index such as cu128 for an NVIDIA image
ARG TORCH_INDEX=cpu

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    ENCORE_CONFIG_DIR=/config \
    ENCORE_LIBRARY_DIR=/library \
    XDG_CACHE_HOME=/config/cache \
    HOME=/config \
    PORT=8080

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

RUN pip install torch torchaudio --index-url https://download.pytorch.org/whl/${TORCH_INDEX}

WORKDIR /app
COPY backend/requirements.txt ./
# deno is the JavaScript runtime yt-dlp needs for YouTube
RUN pip install -r requirements.txt deno

COPY backend/encore ./encore
COPY --from=web /src/backend/encore/static ./encore/static
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/config", "/library"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD python -c "import os,urllib.request;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8080\")}/api/health',timeout=4)"

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
