# Encore

Self-hosted karaoke for any song. Search YouTube Music, and Encore downloads the track, splits it into vocals and instrumental with an AI model, finds synced lyrics and plays it on a big screen with a slider for how much of the original singer you still want to hear.

- **Any song**: search YouTube Music or paste a YouTube link. Audio comes from yt-dlp, metadata and cover art from YouTube Music.
- **Vocal slider**: Demucs (Meta's source separation model) splits every song into `vocals` and `instrumental`. Both stems play sample-locked in the browser, the slider is just the vocal volume (0 % = pure karaoke, 30 % = guide vocals).
- **Synced lyrics**: from [LRCLIB](https://lrclib.net) or YouTube Music, with a fill effect, countdown dots in instrumental breaks and a per-song timing offset. You can paste your own LRC.
- **Phone friendly, installable, offline**: on phones the app gets a bottom tab bar and touch-sized controls. Install it to the home screen or start menu (Edge, Chrome, Android, iOS Safari). Save songs on a device and they play without a connection to Encore, with lyrics and word timing. Needs https, see [Install as an app](#install-as-an-app).
- **Word timing**: LRC files only time whole lines, often for a slightly different release. Encore aligns every word on the separated vocal track (torchaudio's MMS_FA model, CPU is fine, about 20 to 60 s per song), so the fill follows the singer and rests in pauses. Lines it is unsure about keep the LRC time, and plain lyrics without timestamps get synced the same way. Latin-script lyrics only for now.
- **Backgrounds**: aurora (colours taken from the cover), audio visualizer, cover art, the official music video (muted, synced), or your own uploaded image or video.
- **Party queue**: phones on the same network open the same page, search, and line up with their name. The TV shows who's next and counts down.
- **Everything stays local**: processed songs live in a mounted folder, settings in `config.json`, data in SQLite. A song is prepared once and starts instantly after that.

## Run it

Both variants use the latest release from GHCR: `ghcr.io/eliasthecactus/encore:latest` (amd64 and arm64).

### Docker run

```bash
docker run -d --name encore \
  -p 8080:8080 \
  -e PUID=1000 -e PGID=1000 -e TZ=Europe/Zurich \
  -v "$(pwd)/config:/config" \
  -v "$(pwd)/library:/library" \
  --restart unless-stopped \
  ghcr.io/eliasthecactus/encore:latest
```

### Docker Compose

Save this as `docker-compose.yml` (same as the [one in this repo](docker-compose.yml)):

```yaml
services:
  encore:
    image: ghcr.io/eliasthecactus/encore:latest
    container_name: encore
    ports:
      - "8080:8080"
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Zurich
    volumes:
      - ./config:/config     # settings, SQLite database, AI models, backgrounds
      - ./library:/library   # processed songs
    restart: unless-stopped
```

then start it:

```bash
docker compose up -d
```

Update to a new release:

```bash
docker compose pull && docker compose up -d
```

Open http://localhost:8080 on the machine connected to the TV, and the same address (with the server's IP) on phones. Set `PUID`/`PGID` to your user (`id -u` / `id -g`) so the files in `config` and `library` belong to you.

### Folders

| Mount      | Contents |
|------------|----------|
| `/config`  | `config.json` (settings), `encore.db` (SQLite), `models/` (Demucs weights about 80 MB and the word-timing model about 1.2 GB, both downloaded on first use), `backgrounds/` (your uploads), `cache/`, optional `cookies.txt` |
| `/library` | one folder per song: `instrumental.mp3`, `vocals.mp3`, `source.*`, `cover.jpg`, `video.mp4` |

### Environment

| Variable | Default | |
|---|---|---|
| `PUID` / `PGID` | `1000` | user the app runs as, owns the mounted folders |
| `PORT` | `8080` | |
| `ENCORE_UPDATE_YTDLP` | `true` | update yt-dlp on every container start (YouTube changes often), skipped automatically without internet |
| `ENCORE_MODEL` | `htdemucs` | `htdemucs`, `htdemucs_ft` (about 4x slower, cleaner) or `mdx_extra` |
| `ENCORE_DEVICE` | `auto` | `auto`, `cpu`, `cuda` |
| `ENCORE_DOWNLOAD_VIDEO` | `true` | also fetch the music video as a background |
| `ENCORE_ALIGN_LYRICS` | `true` | time every word on the vocal track |

Every key in `config.json` can be overridden the same way (`ENCORE_<KEY>`), and everything is editable in the Settings page.

### Offline

Once songs are in the library, Encore works without internet: stems, covers, music videos and lyrics are stored locally and the web app is bundled. Phones only need the local network. Searching and adding new songs needs internet. Without a connection the container skips the yt-dlp update and starts in a few seconds.

### Install as an app

Encore is a Progressive Web App. Browsers only allow installing it and using it offline over **https** (or on `localhost`), so on your network put it behind a reverse proxy with a certificate:

- **Caddy**, **Nginx Proxy Manager**, **Traefik** or the reverse proxy you already run, pointing at `http://<encore-host>:8080`. A minimal Caddyfile: `karaoke.example.com { reverse_proxy encore:8080 }`.
- **Tailscale**: `tailscale serve --bg 8080` on the Encore host gives you `https://<host>.<tailnet>.ts.net` with a valid certificate, also on your phone.

Over plain http on a LAN address everything else works, only "Install" and "Save on this device" are missing.

Then:

- **Edge / Chrome (desktop)**: the install icon in the address bar, or the menu: Apps > Install Encore. Settings in Encore also has an Install button.
- **Android**: menu > Install app (or Add to Home screen).
- **iPhone / iPad**: Safari > Share > Add to Home Screen.

**Offline**: the app itself and the last known library open without a connection. Songs you save with "Save on this device" (song menu in the library) play fully offline, stems, cover, lyrics and word timing included, about 15 MB per song. Search, the queue and settings need the connection to Encore. Settings > This device shows what is stored and removes it.

### How long does a song take?

Download a few seconds, separation depends on the CPU: roughly 30 to 60 seconds for a 4 minute song on a recent desktop or Apple Silicon CPU, a few minutes on a small NAS or Raspberry Pi class device. With an NVIDIA GPU it is a few seconds. Songs are processed one after another, the library shows progress.

### NVIDIA GPU

The published image is CPU only (amd64 and arm64). For CUDA, build it yourself:

```bash
docker build --build-arg TORCH_INDEX=cu128 -t encore:cuda .
```

and uncomment the `deploy.resources` block in `docker-compose.yml`.

### Downloads failing?

YouTube sometimes asks for a sign in ("confirm you're not a bot"), especially from data centre IPs. Export your YouTube cookies in Netscape format (for example with a "cookies.txt" browser extension) and put the file at `/config/cookies.txt`. Keep `ENCORE_UPDATE_YTDLP=true`.

## Keyboard on the stage

| Key | |
|---|---|
| Space | play / pause |
| ← → | seek 5 s |
| ↑ ↓ | vocals ±10 % |
| `[` `]` | lyrics earlier / later (saved per song) |
| B | next background |
| N | next song in the queue |
| F | fullscreen |

## Development

```bash
# backend (Python 3.12)
cd backend
uv venv -p 3.12 .venv && source .venv/bin/activate
uv pip install -r requirements.txt torch torchaudio deno
ENCORE_CONFIG_DIR=../dev/config ENCORE_LIBRARY_DIR=../dev/library uvicorn encore.main:app --reload --port 8765

# frontend (proxies /api and /media to :8765)
cd frontend && npm install && npm run dev
```

`npm run build` writes the web app into `backend/encore/static`, which the backend serves.

Layout: `backend/encore` (FastAPI app: `main.py` routes, `worker.py` job pipeline, `ytm.py` YouTube Music, `lyrics.py` LRCLIB and LRC parsing, `align.py` word timing on the vocal stem, `db.py` SQLite, `config.py` settings), `frontend/src` (React + Vite: `audio.ts` stem player, `components/Stage.tsx` player, `Lyrics.tsx`, `Background.tsx`).

Releases: pushing to `main` publishes `ghcr.io/<owner>/encore:edge`, a `v1.2.3` tag publishes `1.2.3`, `1.2` and `latest` ([workflow](.github/workflows/release.yml)).

## Notes

Encore is meant for private use with music you're allowed to use. Downloading from YouTube may be against YouTube's terms of service, check what applies to you. Lyrics belong to their rights holders; LRCLIB and YouTube Music are queried at runtime and nothing is redistributed.

Built with substantial help from an AI coding assistant (Claude).

License: MIT
