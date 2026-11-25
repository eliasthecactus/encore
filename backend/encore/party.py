"""Party mode: guests join the stage with a 6 digit code and control it from their phones.

One party at a time, kept in memory (a restart ends it). The stage that started the party is the
host. It holds a host token, plays the music and publishes its state; guests hold guest tokens,
add songs to the queue and remove their own. Guests with the admin role (the first guest, or
whom the host makes admin) also send commands (play, pause, next, seek, vocals, volume,
background) that the server relays to the host over a WebSocket.

Brute force: a code has 1'000'000 values. Wrong codes are limited per client address and, because
an address can be faked behind a proxy, also across all clients together:
  per address   5 wrong codes per 5 minutes
  all clients  30 wrong codes per 10 minutes
That allows at most about 180 guesses an hour, so guessing a code in a 6 hour party succeeds with
a probability of roughly 0.1 %. A new code (host action) makes earlier guesses worthless.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import math
import re
import secrets
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("encore.party")

CODE_DIGITS = 6
MAX_GUESTS = 60
NAME_MAX = 24
HOST_GONE_TTL = 4 * 3600  # a party whose stage has been offline this long ends
STATE_MAX_BYTES = 4096

BACKGROUNDS = ("aurora", "visualizer", "cover", "video", "custom")
ROLES = ("admin", "member")  # the first guest of a party is admin, everyone after a member


class RateLimiter:
    """Sliding window: at most `limit` hits per `window` seconds for each key."""

    def __init__(self, limit: int, window: float, max_keys: int = 20000) -> None:
        self.limit, self.window, self.max_keys = limit, window, max_keys
        self.hits: OrderedDict[str, deque[float]] = OrderedDict()

    def _trim(self, key: str, now: float) -> deque[float]:
        q = self.hits.get(key)
        if q is None:
            q = self.hits[key] = deque()
            while len(self.hits) > self.max_keys:  # forget the oldest keys, never the window logic
                self.hits.popitem(last=False)
        while q and q[0] <= now - self.window:
            q.popleft()
        return q

    def wait(self, key: str) -> float:
        """Seconds until the next hit is allowed, 0 if it is allowed now."""
        now = time.monotonic()
        q = self._trim(key, now)
        if len(q) < self.limit:
            return 0.0
        return max(0.0, q[0] + self.window - now)

    def hit(self, key: str) -> None:
        now = time.monotonic()
        self._trim(key, now).append(now)
        self.hits.move_to_end(key)

    def take(self, key: str) -> float:
        """Count a hit if allowed; returns the wait (0 = counted and allowed)."""
        w = self.wait(key)
        if not w:
            self.hit(key)
        return w


# ---- connections -------------------------------------------------------------------

class Conn:
    """One WebSocket with its own send queue, so a slow phone never blocks the others."""

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=200)
        self.task = asyncio.create_task(self._pump())

    async def _pump(self) -> None:
        try:
            while (msg := await self.queue.get()) is not None:
                await self.ws.send_json(msg)
        except Exception:  # noqa: BLE001 - socket gone
            pass

    def send(self, msg: dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(msg)
        except asyncio.QueueFull:
            pass  # a client this far behind gets the next state update anyway

    async def close(self, code: int = 1000) -> None:
        """Send what is queued (e.g. "ended"), then close."""
        self.send_close()
        try:
            await asyncio.wait_for(asyncio.shield(self.task), 2)
        except Exception:  # noqa: BLE001
            self.task.cancel()
        try:
            await self.ws.close(code)
        except Exception:  # noqa: BLE001
            pass

    def send_close(self) -> None:
        try:
            self.queue.put_nowait(None)
        except asyncio.QueueFull:
            self.task.cancel()


@dataclass
class Guest:
    id: str
    name: str
    token: str
    role: str = "member"  # "admin": controls the music too, "member": queue only
    joined_at: float = field(default_factory=time.time)
    conns: set[Conn] = field(default_factory=set)
    entries: set[int] = field(default_factory=set)  # queue entries this guest added

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "role": self.role, "joined_at": self.joined_at, "online": bool(self.conns)}

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


def new_code() -> str:
    return f"{secrets.randbelow(10 ** CODE_DIGITS):0{CODE_DIGITS}d}"


def clean_name(raw: str) -> str:
    name = re.sub(r"[\x00-\x1f\x7f]", "", raw or "")
    return re.sub(r"\s+", " ", name).strip()[:NAME_MAX]


class Party:
    def __init__(self) -> None:
        self.code = new_code()
        self.host_token = secrets.token_urlsafe(32)
        self.created_at = time.time()
        self.guests: dict[str, Guest] = {}
        self.host_conns: set[Conn] = set()
        self.host_seen = time.time()
        self.state: dict[str, Any] = {}
        self.had_guests = False  # the first guest becomes admin

    # ---- lookup ----
    def is_host(self, token: str) -> bool:
        return bool(token) and hmac.compare_digest(token, self.host_token)

    def guest_by_token(self, token: str) -> Guest | None:
        if not token:
            return None
        for g in self.guests.values():
            if hmac.compare_digest(token, g.token):
                return g
        return None

    def owner_of(self, entry_id: int) -> Guest | None:
        return next((g for g in self.guests.values() if entry_id in g.entries), None)

    @property
    def host_online(self) -> bool:
        return bool(self.host_conns)

    # ---- messages ----
    def to_host(self, msg: dict[str, Any]) -> None:
        for c in list(self.host_conns):
            c.send(msg)

    def to_guests(self, msg: dict[str, Any]) -> None:
        for g in self.guests.values():
            for c in list(g.conns):
                c.send(msg)

    def broadcast(self, msg: dict[str, Any]) -> None:
        self.to_host(msg)
        self.to_guests(msg)

    def guest_list(self) -> list[dict[str, Any]]:
        return [g.public() for g in sorted(self.guests.values(), key=lambda g: g.joined_at)]

    def guests_changed(self) -> None:
        self.to_host({"type": "guests", "guests": self.guest_list()})

    def stage_message(self) -> dict[str, Any]:
        return {"type": "state", "state": self.state, "host_online": self.host_online}

    def info(self) -> dict[str, Any]:
        return {"code": self.code, "guests": self.guest_list(), "created_at": self.created_at,
                "join_locked_for": math.ceil(manager.join_all.wait("all"))}

    async def end(self, reason: str) -> None:
        conns = [*self.host_conns, *(c for g in self.guests.values() for c in g.conns)]
        for c in conns:
            c.send({"type": "ended", "reason": reason})
            await c.close(4000)
        self.host_conns.clear()
        for g in self.guests.values():
            g.conns.clear()


class Manager:
    def __init__(self) -> None:
        self.party: Party | None = None
        self.join_ip = RateLimiter(5, 300)
        self.join_all = RateLimiter(30, 600)
        self.guest_search = RateLimiter(20, 60)
        self.guest_add = RateLimiter(12, 300)
        self.guest_cmd = RateLimiter(40, 10)

    def current(self) -> Party | None:
        p = self.party
        if p and not p.host_online and time.time() - p.host_seen > HOST_GONE_TTL:
            log.info("party ended: the stage was offline for %d h", HOST_GONE_TTL // 3600)
            asyncio.create_task(p.end("expired"))
            self.party = None
        return self.party

    async def start(self) -> Party:
        if self.party:
            await self.party.end("replaced")
        self.party = Party()
        log.info("party started")
        return self.party

    async def stop(self) -> None:
        if self.party:
            await self.party.end("ended")
            log.info("party ended by the host")
        self.party = None

    def join_wait(self, ip: str) -> float:
        return max(self.join_ip.wait(ip), self.join_all.wait("all"))

    def join_failed(self, ip: str) -> None:
        self.join_ip.hit(ip)
        self.join_all.hit("all")
        if self.join_all.wait("all"):
            log.warning("party join locked: too many wrong codes from all clients")

    def notify_queue(self) -> None:
        p = self.current()
        if p:
            p.broadcast({"type": "queue"})


manager = Manager()


# ---- commands from guests -------------------------------------------------------------

def clean_command(msg: dict[str, Any]) -> dict[str, Any] | None:
    """Only known actions with values in range get through to the stage."""
    action = msg.get("action")
    value = msg.get("value")
    if action in ("toggle", "play", "pause", "next", "restart"):
        return {"action": action}
    if action in ("seek", "skip"):
        if isinstance(value, (int, float)) and math.isfinite(value) and abs(value) <= 24 * 3600:
            return {"action": action, "value": float(value)}
        return None
    if action in ("vocals", "volume"):
        if isinstance(value, (int, float)) and math.isfinite(value):
            return {"action": action, "value": min(1.0, max(0.0, float(value)))}
        return None
    if action == "background" and value in BACKGROUNDS:
        return {"action": action, "value": value}
    return None


def clean_state(state: Any) -> dict[str, Any]:
    """The host's state is passed on as is, but only as a small plain object."""
    import json

    if not isinstance(state, dict):
        return {}
    try:
        if len(json.dumps(state)) > STATE_MAX_BYTES:
            return {}
    except (TypeError, ValueError):
        return {}
    return state


async def serve(ws: WebSocket) -> None:
    """WebSocket /api/session/ws. The first message must be {"type": "hello", "token": ...}."""
    await ws.accept()
    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=10)
    except Exception:  # noqa: BLE001
        await ws.close(4400)
        return
    p = manager.current()
    token = hello.get("token") if isinstance(hello, dict) else None
    token = token if isinstance(token, str) else ""
    if not p:
        await ws.send_json({"type": "ended", "reason": "no-party"})
        await ws.close(4404)
        return
    guest = None if p.is_host(token) else p.guest_by_token(token)
    if not guest and not p.is_host(token):
        await ws.send_json({"type": "ended", "reason": "unauthorized"})
        await ws.close(4401)
        return

    conn = Conn(ws)
    if guest:
        guest.conns.add(conn)
        conn.send({"type": "welcome", "role": "guest", "guest": guest.public()})
        conn.send(p.stage_message())
        p.guests_changed()
    else:
        p.host_conns.add(conn)
        p.host_seen = time.time()
        conn.send({"type": "welcome", "role": "host", **p.info()})
        p.to_guests(p.stage_message())

    try:
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict) or manager.party is not p:
                continue
            kind = msg.get("type")
            if kind == "ping":
                conn.send({"type": "pong"})
            elif guest and kind == "cmd":
                if guest.id not in p.guests:  # kicked meanwhile
                    break
                if manager.guest_cmd.take(guest.id):
                    conn.send({"type": "error", "detail": "Slow down a little"})
                    continue
                if not guest.is_admin:
                    conn.send({"type": "error", "detail": "Only party admins can control the music"})
                    continue
                cmd = clean_command(msg)
                if not cmd:
                    continue
                if not p.host_online:
                    conn.send({"type": "error", "detail": "The stage is not connected right now"})
                    continue
                p.to_host({"type": "cmd", **cmd, "by": guest.name})
            elif not guest and kind == "state":
                p.state = clean_state(msg.get("state"))
                p.host_seen = time.time()
                p.to_guests(p.stage_message())
    except Exception:  # noqa: BLE001 - disconnect or bad JSON
        pass
    finally:
        conn.send_close()
        if guest:
            guest.conns.discard(conn)
            if manager.party is p:
                p.guests_changed()
        else:
            p.host_conns.discard(conn)
            p.host_seen = time.time()
            if p.state and not p.host_conns:
                p.state = {**p.state, "playing": False}  # a closed or reloaded stage has stopped the music
            if manager.party is p:
                p.to_guests(p.stage_message())
