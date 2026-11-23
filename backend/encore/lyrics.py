"""Lyrics lookup (LRCLIB, YouTube Music) and LRC parsing."""

from __future__ import annotations

import re
from typing import Any

import requests

from . import __version__, config, ytm

LRCLIB = "https://lrclib.net/api"
HEADERS = {"User-Agent": f"Encore/{__version__} (self-hosted karaoke)"}

_TIME = re.compile(r"\[(\d+):(\d+(?:[.:]\d+)?)\]")
_WORD = re.compile(r"<(\d+):(\d+(?:[.:]\d+)?)>")
_META = re.compile(r"^\[(ar|ti|al|by|offset|length|re|ve|au):", re.I)


def _clean_title(title: str) -> str:
    # "Song (Remastered 2011)" -> "Song"; LRCLIB matches better on the bare name.
    return re.sub(r"\s*[\(\[][^)\]]*(remaster|version|edit|mix|live|mono|stereo)[^)\]]*[\)\]]", "", title, flags=re.I).strip()


def _first_artist(artist: str) -> str:
    return re.split(r",| & | feat\.? | ft\.? ", artist, maxsplit=1)[0].strip()


def from_lrclib(title: str, artist: str, album: str, duration: float) -> tuple[str, bool] | None:
    params = {"track_name": _clean_title(title), "artist_name": _first_artist(artist)}
    if album:
        params["album_name"] = album
    if duration:
        params["duration"] = int(round(duration))
    try:
        r = requests.get(f"{LRCLIB}/get", params=params, headers=HEADERS, timeout=15)
        if r.ok:
            data = r.json()
            if data.get("syncedLyrics"):
                return data["syncedLyrics"], True
        # Fuzzy fallback: search and pick the closest duration with synced lyrics.
        r = requests.get(
            f"{LRCLIB}/search",
            params={"track_name": params["track_name"], "artist_name": params["artist_name"]},
            headers=HEADERS, timeout=15,
        )
        if not r.ok:
            return None
        hits = [h for h in r.json() if not h.get("instrumental")]
        synced = [h for h in hits if h.get("syncedLyrics")]
        pool = synced or hits
        if not pool:
            return None
        if duration:
            pool.sort(key=lambda h: abs(float(h.get("duration") or 0) - duration))
            if synced and abs(float(pool[0].get("duration") or 0) - duration) > 8:
                return None  # probably a different recording, timestamps would be off
        best = pool[0]
        if best.get("syncedLyrics"):
            return best["syncedLyrics"], True
        if best.get("plainLyrics"):
            return best["plainLyrics"], False
    except (requests.RequestException, ValueError):
        return None
    return None


def fetch(song: dict[str, Any]) -> tuple[str, bool, str]:
    """Try every configured source; prefer synced lyrics from any source over plain text."""
    plain: tuple[str, str] | None = None
    for source in config.get().get("lyrics_sources", ["lrclib", "ytmusic"]):
        try:
            if source == "lrclib":
                res = from_lrclib(song["title"], song["artist"], song["album"], song["duration"])
            elif source == "ytmusic":
                res = ytm.timed_lyrics(song["id"])
            else:
                continue
        except Exception:
            res = None
        if not res:
            continue
        text, synced = res
        if synced:
            return text, True, source
        plain = plain or (text, source)
    if plain:
        return plain[0], False, plain[1]
    return "", False, ""


def _secs(m: str, s: str) -> float:
    return int(m) * 60 + float(s.replace(":", "."))


def parse(text: str, synced: bool) -> list[dict[str, Any]]:
    """Return [{t, end, text, words:[{t, text}]}]. Unsynced lyrics get t=None."""
    if not text:
        return []
    if not synced:
        return [{"t": None, "end": None, "text": line.strip(), "words": []}
                for line in text.splitlines()]
    lines: list[dict[str, Any]] = []
    for raw in text.splitlines():
        raw = raw.strip()
        if not raw or _META.match(raw):
            continue
        stamps = _TIME.findall(raw)
        if not stamps:
            continue
        body = _TIME.sub("", raw).strip()
        words = []
        if _WORD.search(body):
            parts = re.split(r"(<\d+:\d+(?:[.:]\d+)?>)", body)
            current: float | None = _secs(*stamps[0])
            for p in parts:
                m = _WORD.fullmatch(p)
                if m:
                    current = _secs(*m.groups())
                elif p.strip() and current is not None:
                    words.append({"t": current, "text": p})
            body = _WORD.sub("", body)
        for m, s in stamps:
            lines.append({"t": _secs(m, s), "end": None, "text": body.strip(), "words": words})
    lines.sort(key=lambda line: line["t"])
    for i, line in enumerate(lines):
        nxt = lines[i + 1]["t"] if i + 1 < len(lines) else line["t"] + 6
        line["end"] = min(nxt, line["t"] + 12)  # a line never "sings" longer than 12 s
    return lines
