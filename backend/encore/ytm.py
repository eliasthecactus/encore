"""YouTube Music metadata via ytmusicapi (no account needed)."""

from __future__ import annotations

import re
import threading
from typing import Any
from urllib.parse import parse_qs, urlparse

from ytmusicapi import YTMusic

from . import config

_local = threading.local()
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def client() -> YTMusic:
    lang = config.get().get("ytmusic_language", "en")
    if getattr(_local, "lang", None) != lang:
        try:
            _local.client = YTMusic(language=lang)
        except Exception:
            _local.client = YTMusic()
        _local.lang = lang
    return _local.client


def big_thumb(url: str, size: int = 1200) -> str:
    """Google image URLs encode their size (=w120-h120-...). Ask for a larger one."""
    if not url:
        return ""
    if "googleusercontent.com" in url or "ggpht.com" in url:
        return re.sub(r"=w\d+-h\d+", f"=w{size}-h{size}", url)
    return url


def _best_thumb(thumbs: list[dict[str, Any]] | None) -> str:
    if not thumbs:
        return ""
    best = max(thumbs, key=lambda t: t.get("width", 0) * t.get("height", 0))
    return big_thumb(best.get("url", ""))


def _artists(item: dict[str, Any]) -> str:
    names = [a.get("name", "") for a in item.get("artists") or [] if a.get("name")]
    return ", ".join(names)


def _song(item: dict[str, Any]) -> dict[str, Any] | None:
    vid = item.get("videoId")
    if not vid:
        return None
    album = item.get("album") or {}
    return {
        "id": vid,
        "title": item.get("title") or "",
        "artist": _artists(item),
        "album": album.get("name", "") if isinstance(album, dict) else str(album),
        "duration": float(item.get("duration_seconds") or 0),
        "thumbnail": _best_thumb(item.get("thumbnails")),
        "kind": item.get("resultType", "song"),
    }


def search(query: str, limit: int = 20) -> list[dict[str, Any]]:
    results = client().search(query, filter="songs", limit=limit)
    out = [s for s in (_song(r) for r in results) if s]
    return out[:limit]


def parse_video_id(text: str) -> str | None:
    text = text.strip()
    if _ID_RE.match(text):
        return text
    try:
        u = urlparse(text)
    except ValueError:
        return None
    if u.hostname and u.hostname.endswith("youtu.be"):
        vid = u.path.lstrip("/")[:11]
        return vid if _ID_RE.match(vid) else None
    vid = (parse_qs(u.query).get("v") or [""])[0]
    if _ID_RE.match(vid):
        return vid
    m = re.search(r"/(?:shorts|embed|live)/([A-Za-z0-9_-]{11})", u.path)
    return m.group(1) if m else None


def song_metadata(video_id: str) -> dict[str, Any]:
    """Metadata for a single id. Prefers the watch playlist (has album info)."""
    yt = client()
    try:
        wp = yt.get_watch_playlist(video_id, limit=1)
        track = next((t for t in wp.get("tracks", []) if t.get("videoId") == video_id), None)
        if track:
            album = track.get("album") or {}
            length = track.get("length") or ""
            return {
                "id": video_id,
                "title": track.get("title") or video_id,
                "artist": _artists(track),
                "album": album.get("name", "") if isinstance(album, dict) else "",
                "duration": _parse_length(length),
                "thumbnail": _best_thumb(track.get("thumbnail") or track.get("thumbnails")),
            }
    except Exception:
        pass
    details = yt.get_song(video_id).get("videoDetails", {})
    return {
        "id": video_id,
        "title": details.get("title") or video_id,
        "artist": details.get("author", ""),
        "album": "",
        "duration": float(details.get("lengthSeconds") or 0),
        "thumbnail": _best_thumb((details.get("thumbnail") or {}).get("thumbnails")),
    }


def _parse_length(s: str) -> float:
    try:
        parts = [int(p) for p in s.split(":")]
    except ValueError:
        return 0.0
    total = 0
    for p in parts:
        total = total * 60 + p
    return float(total)


def find_music_video(title: str, artist: str, duration: float, exclude: str) -> str | None:
    """Look for the official music video of a song (used as a background)."""
    try:
        results = client().search(f"{artist} {title}", filter="videos", limit=5)
    except Exception:
        return None
    title_l = title.lower()
    for r in results:
        vid = r.get("videoId")
        if not vid or vid == exclude:
            continue
        name = (r.get("title") or "").lower()
        if title_l.split("(")[0].strip() and title_l.split("(")[0].strip() not in name:
            continue
        d = float(r.get("duration_seconds") or 0)
        # Videos with long intros/outros are fine, a 10 minute "full album" is not.
        if duration and d and d > duration * 1.6:
            continue
        return vid
    return None


def timed_lyrics(video_id: str) -> tuple[str, bool] | None:
    """Return (text, synced). Synced text is formatted as LRC."""
    yt = client()
    wp = yt.get_watch_playlist(video_id, limit=1)
    browse = wp.get("lyrics")
    if not browse:
        return None
    try:
        data = yt.get_lyrics(browse, timestamps=True)
    except Exception:
        data = yt.get_lyrics(browse)
    if not data or not data.get("lyrics"):
        return None
    if data.get("hasTimestamps"):
        lines = []
        for line in data["lyrics"]:
            t = line.start_time / 1000.0
            lines.append(f"[{int(t // 60):02d}:{t % 60:05.2f}]{line.text}")
        return "\n".join(lines), True
    return str(data["lyrics"]), False
