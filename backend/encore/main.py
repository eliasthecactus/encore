"""Encore HTTP API + static web app."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import math
import mimetypes
import re
import secrets
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import requests

import yt_dlp
from fastapi import FastAPI, HTTPException, Request, UploadFile, WebSocket
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from . import __version__, align, config, db, lyrics, party, ytm
from .worker import song_dir, worker

# Slim images may lack /etc/mime.types; stems in .m4a should not be served as octet-stream.
mimetypes.add_type("audio/mp4", ".m4a")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("encore")

THUMB_HOSTS = ("googleusercontent.com", "ytimg.com", "ggpht.com")
THUMB_DIR = config.CONFIG_DIR / "cache" / "thumbs"

MEDIA_TYPES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".webm", ".mov"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    config.ensure_dirs()
    config.load()
    db.init()
    worker.start()
    log.info("Encore %s, library=%s config=%s", __version__, config.LIBRARY_DIR, config.CONFIG_DIR)
    yield
    worker.stop()


app = FastAPI(title="Encore", version=__version__, lifespan=lifespan)


# ---- helpers -----------------------------------------------------------------

def thumb_url(url: str, size: int | None = None) -> str:
    """Route remote cover art through /api/thumb so browsers only talk to Encore."""
    if not url:
        return ""
    if size:
        url = ytm.big_thumb(url, size)
    return f"/api/thumb?u={quote(url, safe='')}"


def _public(song: dict[str, Any]) -> dict[str, Any]:
    sid = song["id"]
    out = {k: v for k, v in song.items() if k != "lyrics"}
    out["cover"] = f"/media/{sid}/cover.jpg" if song.get("has_cover") else thumb_url(song.get("thumbnail", ""), 600)
    if song.get("status") == "ready":
        folder = song_dir(sid)
        files = {n: config.stem_file(folder, n) for n in config.STEM_NAMES}
        if all(files.values()):
            out["stems"] = {n: f"/media/{sid}/{f.name}" for n, f in files.items()}
        out["video"] = f"/media/{sid}/video.mp4" if song.get("has_video") else None
    return out


def _require(song_id: str) -> dict[str, Any]:
    song = db.get_song(song_id)
    if not song:
        raise HTTPException(404, "song not found")
    return song


# ---- search & library --------------------------------------------------------

@app.get("/api/search")
async def search(q: str, limit: int = 20):
    q = q.strip()
    if not q:
        return []
    vid = ytm.parse_video_id(q) if ("/" in q or len(q) == 11) else None
    try:
        if vid:
            results = [await run_in_threadpool(ytm.song_metadata, vid)]
        else:
            results = await run_in_threadpool(ytm.search, q, min(limit, 40))
    except Exception as exc:
        raise HTTPException(502, f"YouTube Music search failed: {exc}") from exc
    known = db.statuses([r["id"] for r in results])
    for r in results:
        r["status"] = known.get(r["id"])
        r["thumb"] = thumb_url(r["thumbnail"], 240)
    return results


@app.get("/api/thumb")
async def thumb(u: str):
    host = urlparse(u).hostname or ""
    if urlparse(u).scheme != "https" or not host.endswith(THUMB_HOSTS):
        raise HTTPException(400, "unsupported image host")
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    path = THUMB_DIR / (hashlib.sha1(u.encode()).hexdigest() + ".jpg")
    if not path.exists():
        def fetch() -> bytes:
            r = requests.get(u, timeout=15)
            r.raise_for_status()
            return r.content
        try:
            data = await run_in_threadpool(fetch)
        except requests.RequestException as exc:
            raise HTTPException(502, "image fetch failed") from exc
        path.write_bytes(data)
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=604800"})


class AddSong(BaseModel):
    id: str | None = None
    url: str | None = None
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    duration: float | None = None
    thumbnail: str | None = None
    singer: str | None = None  # also put it in the party queue


async def _ensure_song(body: AddSong) -> dict[str, Any]:
    """Add the song to the library (download + separation start in the background)."""
    raw = body.id or body.url or ""
    vid = ytm.parse_video_id(raw)  # also guarantees a safe folder name
    if not vid:
        raise HTTPException(400, "need a YouTube video id or URL")
    existing = db.get_song(vid)
    if not existing:
        if body.title:
            meta = {"id": vid, "title": body.title, "artist": body.artist or "", "album": body.album or "",
                    "duration": body.duration or 0, "thumbnail": body.thumbnail or ""}
        else:
            try:
                meta = await run_in_threadpool(ytm.song_metadata, vid)
            except Exception as exc:
                raise HTTPException(502, f"could not load metadata: {exc}") from exc
        db.insert_song(meta)
        worker.poke()
    elif existing["status"] == "error":
        db.update_song(vid, status="queued", progress=0, error="")
        worker.poke()
    return db.get_song(vid) or {}


@app.post("/api/songs")
async def add_song(body: AddSong):
    song = await _ensure_song(body)
    if body.singer is not None:
        db.add_to_queue(song["id"], body.singer.strip())
        party.manager.notify_queue()
    return _public(song)


@app.get("/api/songs")
async def list_songs():
    return [_public(s) for s in db.list_songs()]


@app.get("/api/songs/{song_id}")
async def get_song(song_id: str):
    song = _require(song_id)
    out = _public(song)
    timing = align.load_timing(song_dir(song_id), song["lyrics"])
    lines, synced = align.apply_timing(lyrics.parse(song["lyrics"], bool(song["lyrics_synced"])), timing)
    out["lyrics"] = lines
    out["lyrics_synced"] = int(synced)
    out["lyrics_raw"] = song["lyrics"]
    out["lyrics_raw_synced"] = song["lyrics_synced"]
    out["lyrics_timing"] = (
        {"mode": timing["mode"], "aligned": timing.get("aligned", 0), "total": timing.get("total", 0),
         "offset": timing.get("offset", 0)} if timing else None
    )
    return out


def _realign(song_id: str) -> None:
    song = db.get_song(song_id)
    if song and song["status"] == "ready" and song["lyrics"] and config.get().get("align_lyrics", True):
        worker.queue_align(song_id)


class PatchSong(BaseModel):
    title: str | None = None
    artist: str | None = None
    lyrics_offset: float | None = None


@app.patch("/api/songs/{song_id}")
async def patch_song(song_id: str, body: PatchSong):
    _require(song_id)
    db.update_song(song_id, **body.model_dump(exclude_none=True))
    return await get_song(song_id)


@app.delete("/api/songs/{song_id}")
async def delete_song(song_id: str):
    _require(song_id)
    worker.cancel(song_id)
    db.delete_song(song_id)
    shutil.rmtree(song_dir(song_id), ignore_errors=True)
    return {"ok": True}


class Reprocess(BaseModel):
    model: str | None = None
    redownload: bool = False


@app.post("/api/songs/{song_id}/reprocess")
async def reprocess(song_id: str, body: Reprocess):
    _require(song_id)
    if worker.current == song_id:
        raise HTTPException(409, "song is being processed right now")
    folder = song_dir(song_id)
    if body.redownload:
        for p in folder.glob("source.*"):
            p.unlink(missing_ok=True)
    # Removing the stems forces a new separation with the current model.
    for name in config.STEM_NAMES:
        while (stem := config.stem_file(folder, name)) is not None:
            stem.unlink(missing_ok=True)
    if body.model:
        if body.model not in config.MODELS:
            raise HTTPException(400, "unknown model")
        config.update({"model": body.model})
    db.update_song(song_id, status="queued", stage="", progress=0, error="")
    worker.poke()
    return _public(db.get_song(song_id))


@app.post("/api/songs/{song_id}/played")
async def played(song_id: str):
    _require(song_id)
    db.mark_played(song_id)
    return {"ok": True}


class SetLyrics(BaseModel):
    text: str


@app.put("/api/songs/{song_id}/lyrics")
async def set_lyrics(song_id: str, body: SetLyrics):
    _require(song_id)
    text = body.text.strip()
    synced = bool(re.search(r"^\s*\[\d+:\d+", text, re.M))
    db.update_song(song_id, lyrics=text, lyrics_synced=int(synced), lyrics_source="manual" if text else "")
    _realign(song_id)
    return await get_song(song_id)


@app.post("/api/songs/{song_id}/lyrics/refetch")
async def refetch_lyrics(song_id: str):
    song = _require(song_id)
    text, synced, source = await run_in_threadpool(lyrics.fetch, song)
    if text:
        db.update_song(song_id, lyrics=text, lyrics_synced=int(synced), lyrics_source=source)
        _realign(song_id)
    return await get_song(song_id)


@app.post("/api/songs/{song_id}/lyrics/align")
async def align_lyrics(song_id: str):
    song = _require(song_id)
    if song["status"] != "ready":
        raise HTTPException(409, "the song is not ready yet")
    if not song["lyrics"]:
        raise HTTPException(400, "the song has no lyrics")
    worker.queue_align(song_id)
    return _public(db.get_song(song_id))


@app.post("/api/lyrics/align")
async def align_all():
    """Queue word timing for every ready song that has lyrics but no (current) timing."""
    n = 0
    for s in db.list_songs():
        if s["status"] != "ready":
            continue
        full = db.get_song(s["id"]) or {}
        if full.get("lyrics") and not align.load_timing(song_dir(s["id"]), full["lyrics"]):
            worker.queue_align(s["id"])
            n += 1
    return {"queued": n}


# ---- party queue -------------------------------------------------------------

class QueueAdd(BaseModel):
    song_id: str
    singer: str = ""


def _queue_items() -> list[dict[str, Any]]:
    items = db.list_queue()
    for it in items:
        it["cover"] = f"/media/{it['song_id']}/cover.jpg" if it.get("has_cover") else thumb_url(it.get("thumbnail", ""), 240)
    return items


@app.get("/api/queue")
async def get_queue():
    items = _queue_items()
    p = party.manager.current()
    for it in items:
        owner = p.owner_of(it["id"]) if p else None
        it["guest"] = owner.name if owner else None
    return items


@app.post("/api/queue")
async def queue_add(body: QueueAdd):
    _require(body.song_id)
    entry = db.add_to_queue(body.song_id, body.singer.strip())
    party.manager.notify_queue()
    return {"id": entry}


@app.delete("/api/queue/{entry_id}")
async def queue_remove(entry_id: int):
    db.remove_from_queue(entry_id)
    party.manager.notify_queue()
    return {"ok": True}


class QueueOrder(BaseModel):
    ids: list[int]


@app.put("/api/queue/order")
async def queue_order(body: QueueOrder):
    db.reorder_queue(body.ids)
    party.manager.notify_queue()
    return {"ok": True}


@app.delete("/api/queue")
async def queue_clear():
    db.clear_queue()
    party.manager.notify_queue()
    return {"ok": True}


# ---- party mode: guests join with a code ----------------------------------------

def _bearer(request: Request) -> str:
    auth = request.headers.get("authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else ""


def _host(request: Request) -> party.Party:
    p = party.manager.current()
    if not p or not p.is_host(_bearer(request)):
        raise HTTPException(401, "not the host of the current party")
    return p


def _guest(request: Request) -> tuple[party.Party, party.Guest]:
    p = party.manager.current()
    g = p.guest_by_token(_bearer(request)) if p else None
    if not p or not g:
        raise HTTPException(401, "not part of the current party")
    return p, g


def _too_many(wait: float, what: str) -> HTTPException:
    secs = max(1, math.ceil(wait))
    when = f"{secs} s" if secs < 90 else f"{math.ceil(secs / 60)} min"
    return HTTPException(429, f"{what} Try again in {when}.", headers={"Retry-After": str(secs)})


class PartyStart(BaseModel):
    force: bool = False  # end a party another stage is running


@app.get("/api/session/status")
async def party_status():
    return {"active": party.manager.current() is not None}


@app.post("/api/session")
async def party_start(body: PartyStart, request: Request):
    p = party.manager.current()
    if p and p.is_host(_bearer(request)):
        return {**p.info(), "host_token": p.host_token}
    if p and not body.force:
        raise HTTPException(409, "A party is already running on another screen")
    p = await party.manager.start()
    return {**p.info(), "host_token": p.host_token}


@app.get("/api/session")
async def party_info(request: Request):
    return _host(request).info()


@app.post("/api/session/code")
async def party_new_code(request: Request):
    p = _host(request)
    p.code = party.new_code()
    p.to_host({"type": "info", **p.info()})
    return p.info()


@app.delete("/api/session")
async def party_end(request: Request):
    _host(request)
    await party.manager.stop()
    return {"ok": True}


@app.delete("/api/session/guests/{guest_id}")
async def party_kick(guest_id: str, request: Request):
    p = _host(request)
    g = p.guests.pop(guest_id, None)
    if g:
        for c in list(g.conns):
            c.send({"type": "ended", "reason": "removed"})
            await c.close(4003)
        g.conns.clear()
        p.guests_changed()
    return p.info()


class PartyJoin(BaseModel):
    code: str
    name: str


@app.post("/api/session/join")
async def party_join(body: PartyJoin, request: Request):
    ip = request.client.host if request.client else "unknown"
    wait = party.manager.join_wait(ip)
    if wait:
        raise _too_many(wait, "Too many wrong codes.")
    code = re.sub(r"\D", "", body.code)
    p = party.manager.current()
    if not p or len(code) != party.CODE_DIGITS or not hmac.compare_digest(code, p.code):
        party.manager.join_failed(ip)
        await asyncio.sleep(0.6)  # makes scripted guessing slower still
        raise HTTPException(403, "This code does not match a running party")
    name = party.clean_name(body.name)
    if not name:
        raise HTTPException(400, "Please enter your name")
    if len(p.guests) >= party.MAX_GUESTS:
        raise HTTPException(409, "This party is full")
    g = party.Guest(id=secrets.token_hex(6), name=name, token=secrets.token_urlsafe(32))
    p.guests[g.id] = g
    p.guests_changed()
    log.info("guest joined the party (%d guests)", len(p.guests))
    return {"token": g.token, "guest": g.public()}


@app.get("/api/session/me")
async def party_me(request: Request):
    p, g = _guest(request)
    return {"guest": g.public(), "state": p.state, "host_online": p.host_online}


@app.post("/api/session/leave")
async def party_leave(request: Request):
    p, g = _guest(request)
    p.guests.pop(g.id, None)
    for c in list(g.conns):
        await c.close(4000)
    p.guests_changed()
    return {"ok": True}


@app.get("/api/session/queue")
async def party_queue(request: Request):
    p, g = _guest(request)
    out = []
    for it in _queue_items():
        owner = p.owner_of(it["id"])
        out.append({k: it[k] for k in ("id", "song_id", "singer", "title", "artist", "cover", "status",
                                       "stage", "progress", "duration")}
                   | {"mine": it["id"] in g.entries, "guest": owner.name if owner else None})
    return out


@app.get("/api/session/search")
async def party_search(q: str, request: Request):
    _, g = _guest(request)
    if wait := party.manager.guest_search.take(g.id):
        raise _too_many(wait, "Too many searches.")
    return await search(q, 20)


class PartyAdd(AddSong):
    pass


@app.post("/api/session/queue")
async def party_add(body: PartyAdd, request: Request):
    p, g = _guest(request)
    if wait := party.manager.guest_add.take(g.id):
        raise _too_many(wait, "You added a lot of songs.")
    song = await _ensure_song(body)
    singer = party.clean_name(body.singer or "") or g.name
    entry = db.add_to_queue(song["id"], singer)
    g.entries.add(entry)
    party.manager.notify_queue()
    return {"id": entry, "song": _public(song)}


@app.delete("/api/session/queue/{entry_id}")
async def party_remove(entry_id: int, request: Request):
    _, g = _guest(request)
    if entry_id not in g.entries:
        raise HTTPException(403, "You can only remove songs you added")
    db.remove_from_queue(entry_id)
    g.entries.discard(entry_id)
    party.manager.notify_queue()
    return {"ok": True}


@app.websocket("/api/session/ws")
async def party_socket(ws: WebSocket):
    await party.serve(ws)


# ---- settings & backgrounds --------------------------------------------------

@app.get("/api/config")
async def get_config():
    return {"settings": config.get(), "models": config.MODELS, "backgrounds": config.BACKGROUNDS}


@app.put("/api/config")
async def put_config(patch: dict[str, Any]):
    return {"settings": config.update(patch), "models": config.MODELS, "backgrounds": config.BACKGROUNDS}


@app.get("/api/backgrounds")
async def list_backgrounds():
    files = sorted(p for p in config.BACKGROUNDS_DIR.iterdir() if p.suffix.lower() in MEDIA_TYPES)
    return [{"name": p.name, "url": f"/backgrounds/{p.name}",
             "kind": "video" if p.suffix.lower() in {".mp4", ".webm", ".mov"} else "image"} for p in files]


@app.post("/api/backgrounds")
async def upload_background(file: UploadFile):
    name = Path(file.filename or "background").name
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    if Path(name).suffix.lower() not in MEDIA_TYPES:
        raise HTTPException(400, "only images (jpg, png, webp, gif) and videos (mp4, webm, mov)")
    dest = config.BACKGROUNDS_DIR / name
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    config.update({"custom_background": name})
    return {"name": name, "url": f"/backgrounds/{name}"}


@app.delete("/api/backgrounds/{name}")
async def delete_background(name: str):
    p = (config.BACKGROUNDS_DIR / Path(name).name)
    p.unlink(missing_ok=True)
    if config.get().get("custom_background") == p.name:
        config.update({"custom_background": ""})
    return {"ok": True}


@app.get("/api/system")
async def system():
    from .worker import resolve_device

    used = shutil.disk_usage(config.LIBRARY_DIR)
    size = sum(f.stat().st_size for f in config.LIBRARY_DIR.rglob("*") if f.is_file())
    return {
        "version": __version__,
        "yt_dlp": yt_dlp.version.__version__,
        "device": resolve_device(config.get()["device"]),
        "library_bytes": size,
        "disk_free_bytes": used.free,
        "cookies": config.COOKIES_PATH.exists(),
        "processing": worker.current,
    }


@app.get("/api/health")
async def health():
    return {"ok": True}


# ---- static files ------------------------------------------------------------

config.ensure_dirs()
app.mount("/media", StaticFiles(directory=config.LIBRARY_DIR), name="media")
app.mount("/backgrounds", StaticFiles(directory=config.BACKGROUNDS_DIR), name="backgrounds")

if (config.STATIC_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=config.STATIC_DIR / "assets"), name="assets")


# The service worker, manifest and index.html must never be served stale, or app updates get stuck.
NO_CACHE = {"Cache-Control": "no-cache"}
STATIC_TYPES = {".webmanifest": "application/manifest+json", ".js": "text/javascript", ".svg": "image/svg+xml"}


@app.exception_handler(404)
async def spa_fallback(request: Request, exc: Exception):
    path = request.url.path
    index = config.STATIC_DIR / "index.html"
    if not path.startswith(("/api/", "/media/", "/backgrounds/", "/assets/")) and index.exists():
        candidate = (config.STATIC_DIR / path.lstrip("/")).resolve()
        if candidate.is_file() and config.STATIC_DIR in candidate.parents:
            headers = NO_CACHE if candidate.name in ("sw.js", "manifest.webmanifest", "index.html") else None
            return FileResponse(candidate, media_type=STATIC_TYPES.get(candidate.suffix), headers=headers)
        return FileResponse(index, headers=NO_CACHE)
    detail = getattr(exc, "detail", "not found")
    return JSONResponse({"detail": detail}, status_code=404)
