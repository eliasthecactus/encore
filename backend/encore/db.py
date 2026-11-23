"""SQLite storage. One short-lived connection per operation keeps it thread safe."""

from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Iterator

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS songs (
    id              TEXT PRIMARY KEY,          -- YouTube video id of the audio source
    title           TEXT NOT NULL,
    artist          TEXT NOT NULL DEFAULT '',
    album           TEXT NOT NULL DEFAULT '',
    duration        REAL NOT NULL DEFAULT 0,
    thumbnail       TEXT NOT NULL DEFAULT '',  -- remote URL, cover.jpg is cached locally
    status          TEXT NOT NULL DEFAULT 'queued', -- queued|downloading|separating|finishing|ready|error
    stage           TEXT NOT NULL DEFAULT '',
    progress        REAL NOT NULL DEFAULT 0,   -- 0..1 overall
    error           TEXT NOT NULL DEFAULT '',
    model           TEXT NOT NULL DEFAULT '',
    lyrics          TEXT NOT NULL DEFAULT '',  -- LRC (synced) or plain text
    lyrics_synced   INTEGER NOT NULL DEFAULT 0,
    lyrics_source   TEXT NOT NULL DEFAULT '',
    lyrics_offset   REAL NOT NULL DEFAULT 0,   -- seconds, added to every timestamp
    video_id        TEXT NOT NULL DEFAULT '',  -- music video used as background
    has_video       INTEGER NOT NULL DEFAULT 0,
    has_cover       INTEGER NOT NULL DEFAULT 0,
    play_count      INTEGER NOT NULL DEFAULT 0,
    last_played_at  REAL,
    created_at      REAL NOT NULL,
    updated_at      REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id     TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    singer      TEXT NOT NULL DEFAULT '',
    position    REAL NOT NULL,
    created_at  REAL NOT NULL
);
"""

SONG_FIELDS = {
    "title", "artist", "album", "duration", "thumbnail", "status", "stage", "progress", "error",
    "model", "lyrics", "lyrics_synced", "lyrics_source", "lyrics_offset", "video_id", "has_video",
    "has_cover", "play_count", "last_played_at",
}


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init() -> None:
    with connect() as c:
        c.execute("PRAGMA journal_mode = WAL")
        c.executescript(SCHEMA)
        # Jobs that were running when the container stopped get picked up again.
        c.execute(
            "UPDATE songs SET status='queued', stage='', progress=0 "
            "WHERE status IN ('downloading','separating','finishing')"
        )
        # A word-timing job on a ready song does not survive a restart either.
        c.execute("UPDATE songs SET stage='' WHERE status='ready' AND stage!=''")


def _row(r: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(r) if r else None


def get_song(song_id: str) -> dict[str, Any] | None:
    with connect() as c:
        return _row(c.execute("SELECT * FROM songs WHERE id=?", (song_id,)).fetchone())


def list_songs() -> list[dict[str, Any]]:
    with connect() as c:
        rows = c.execute(
            "SELECT id,title,artist,album,duration,thumbnail,status,stage,progress,error,model,"
            "lyrics_synced,lyrics_source,has_video,has_cover,play_count,last_played_at,created_at "
            "FROM songs ORDER BY created_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def statuses(ids: list[str]) -> dict[str, str]:
    if not ids:
        return {}
    with connect() as c:
        q = ",".join("?" * len(ids))
        return {r["id"]: r["status"] for r in c.execute(f"SELECT id,status FROM songs WHERE id IN ({q})", ids)}


def insert_song(song: dict[str, Any]) -> None:
    now = time.time()
    with connect() as c:
        c.execute(
            "INSERT INTO songs (id,title,artist,album,duration,thumbnail,status,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,'queued',?,?)",
            (song["id"], song["title"], song.get("artist", ""), song.get("album", ""),
             float(song.get("duration") or 0), song.get("thumbnail", ""), now, now),
        )


def update_song(song_id: str, **fields: Any) -> None:
    fields = {k: v for k, v in fields.items() if k in SONG_FIELDS}
    if not fields:
        return
    fields["updated_at"] = time.time()
    cols = ",".join(f"{k}=?" for k in fields)
    with connect() as c:
        c.execute(f"UPDATE songs SET {cols} WHERE id=?", (*fields.values(), song_id))


def delete_song(song_id: str) -> None:
    with connect() as c:
        c.execute("DELETE FROM songs WHERE id=?", (song_id,))


def next_queued_song() -> dict[str, Any] | None:
    with connect() as c:
        return _row(c.execute(
            "SELECT * FROM songs WHERE status='queued' ORDER BY created_at ASC LIMIT 1"
        ).fetchone())


def mark_played(song_id: str) -> None:
    with connect() as c:
        c.execute(
            "UPDATE songs SET play_count=play_count+1, last_played_at=? WHERE id=?",
            (time.time(), song_id),
        )


# ---- party queue -------------------------------------------------------------

def list_queue() -> list[dict[str, Any]]:
    with connect() as c:
        rows = c.execute(
            "SELECT q.id, q.song_id, q.singer, q.position, s.title, s.artist, s.thumbnail, "
            "s.status, s.stage, s.progress, s.has_cover, s.duration "
            "FROM queue q JOIN songs s ON s.id=q.song_id ORDER BY q.position ASC, q.id ASC"
        ).fetchall()
        return [dict(r) for r in rows]


def add_to_queue(song_id: str, singer: str) -> int:
    with connect() as c:
        pos = c.execute("SELECT COALESCE(MAX(position),0)+1 FROM queue").fetchone()[0]
        cur = c.execute(
            "INSERT INTO queue (song_id,singer,position,created_at) VALUES (?,?,?,?)",
            (song_id, singer, pos, time.time()),
        )
        return int(cur.lastrowid)


def remove_from_queue(entry_id: int) -> None:
    with connect() as c:
        c.execute("DELETE FROM queue WHERE id=?", (entry_id,))


def reorder_queue(ids: list[int]) -> None:
    with connect() as c:
        for i, entry_id in enumerate(ids):
            c.execute("UPDATE queue SET position=? WHERE id=?", (i + 1, entry_id))


def clear_queue() -> None:
    with connect() as c:
        c.execute("DELETE FROM queue")
