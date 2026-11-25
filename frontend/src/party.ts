/**
 * Party mode: the stage hosts a party, guests join with a 6 digit code and control it.
 * REST calls carry a bearer token; live updates and commands go over one WebSocket.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BackgroundMode, QueueEntry, SearchResult, Song } from "./api";

export interface PartyGuest {
  id: string;
  name: string;
  joined_at: number;
  online: boolean;
}

export interface PartyInfo {
  code: string;
  guests: PartyGuest[];
  created_at: number;
  join_locked_for: number;
}

/** What the stage publishes for the guests' remote. */
export interface StageState {
  song: { id: string; title: string; artist: string; cover: string } | null;
  singer: string;
  playing: boolean;
  blocked: boolean;
  loading: boolean;
  pos: number;
  duration: number;
  vocals: number;
  volume: number;
  bg: BackgroundMode;
  bgAvailable: BackgroundMode[];
  countdown: number | null;
  nextUp: { title: string; singer: string } | null;
}

export type Command =
  | { action: "toggle" | "play" | "pause" | "next" | "restart" }
  | { action: "seek" | "skip" | "vocals" | "volume"; value: number }
  | { action: "background"; value: BackgroundMode };

export type GuestQueueEntry = QueueEntry & { mine: boolean };

export function formatCode(code: string): string {
  const d = code.replace(/\D/g, "").slice(0, 6);
  return d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
}

export function joinUrl(): string {
  return `${location.origin}/join`;
}

// ---- REST ------------------------------------------------------------------------

export class PartyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new PartyError("Encore is not reachable right now", 0);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      if (typeof j.detail === "string") msg = j.detail;
    } catch {
      /* keep status text */
    }
    throw new PartyError(msg, res.status);
  }
  return res.json() as Promise<T>;
}

export const partyApi = {
  status: () => call<{ active: boolean }>("GET", "/api/session/status", null),
  // host
  start: (token: string | null, force = false) =>
    call<PartyInfo & { host_token: string }>("POST", "/api/session", token, { force }),
  info: (token: string) => call<PartyInfo>("GET", "/api/session", token),
  newCode: (token: string) => call<PartyInfo>("POST", "/api/session/code", token),
  end: (token: string) => call("DELETE", "/api/session", token),
  kick: (token: string, id: string) => call<PartyInfo>("DELETE", `/api/session/guests/${id}`, token),
  // guest
  join: (code: string, name: string) =>
    call<{ token: string; guest: PartyGuest }>("POST", "/api/session/join", null, { code, name }),
  me: (token: string) =>
    call<{ guest: PartyGuest; state: Partial<StageState>; host_online: boolean }>("GET", "/api/session/me", token),
  leave: (token: string) => call("POST", "/api/session/leave", token),
  queue: (token: string) => call<GuestQueueEntry[]>("GET", "/api/session/queue", token),
  search: (token: string, q: string) => call<SearchResult[]>("GET", `/api/session/search?q=${encodeURIComponent(q)}`, token),
  add: (token: string, r: Partial<SearchResult>, singer: string) =>
    call<{ id: number; song: Song }>("POST", "/api/session/queue", token, { ...r, singer }),
  remove: (token: string, id: number) => call("DELETE", `/api/session/queue/${id}`, token),
};

// ---- WebSocket -------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PartyMessage = { type: string; [k: string]: any };

/** Keeps one authenticated socket open, reconnecting with backoff until closed or the party ends. */
export class PartySocket {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer = 0;
  private pinger = 0;
  private closed = false;
  connected = false;

  constructor(
    private token: string,
    private onMessage: (m: PartyMessage) => void,
    private onConnection: (connected: boolean) => void = () => {},
  ) {
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/session/ws`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: this.token }));
    ws.onmessage = (e) => {
      let m: PartyMessage;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === "welcome") {
        this.retry = 0;
        this.setConnected(true);
      }
      if (m.type === "ended") this.closed = true; // no point reconnecting
      this.onMessage(m);
    };
    ws.onclose = () => {
      this.setConnected(false);
      window.clearInterval(this.pinger);
      if (this.closed) return;
      const delay = Math.min(15000, 600 * 2 ** this.retry++);
      this.timer = window.setTimeout(() => this.open(), delay);
    };
    // Keeps proxies from dropping a quiet connection.
    this.pinger = window.setInterval(() => this.send({ type: "ping" }), 25000);
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) return;
    this.connected = v;
    this.onConnection(v);
  }

  /** Reconnect right away (e.g. when the phone wakes up). */
  nudge(): void {
    if (this.closed || this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;
    window.clearTimeout(this.timer);
    this.retry = 0;
    this.open();
  }

  send(m: PartyMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.connected) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.timer);
    window.clearInterval(this.pinger);
    this.ws?.close();
  }
}

// ---- storage ---------------------------------------------------------------------

export function stored<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

export function store(key: string, v: unknown): void {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

// ---- host side -------------------------------------------------------------------

const HOST_KEY = "encore.host";

export interface HostParty {
  info: PartyInfo | null;
  connected: boolean;
  error: string;
  /** Resolves "conflict" when another screen runs a party (call again with force). */
  start: (force?: boolean) => Promise<"ok" | "conflict">;
  end: () => Promise<void>;
  newCode: () => Promise<void>;
  kick: (id: string) => Promise<void>;
  /** The stage sends its state here; throttled to what changed. */
  publish: (s: StageState) => void;
  /** The stage registers the handler for guest commands. */
  setHandler: (fn: ((c: Command & { by: string }) => void) | null) => void;
}

export function useHostParty(onQueue: () => void): HostParty {
  const [token, setToken] = useState<string | null>(() => stored<string>(HOST_KEY));
  const [info, setInfo] = useState<PartyInfo | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const socket = useRef<PartySocket | null>(null);
  const handler = useRef<((c: Command & { by: string }) => void) | null>(null);
  const lastState = useRef("");
  const onQueueRef = useRef(onQueue);
  onQueueRef.current = onQueue;

  const forget = useCallback(() => {
    store(HOST_KEY, null);
    setToken(null);
    setInfo(null);
  }, []);

  // Resume a party this screen started before a reload.
  useEffect(() => {
    if (!token) return;
    partyApi.info(token).then(setInfo, (e: PartyError) => {
      if (e.status === 401) forget();
    });
  }, [token, forget]);

  useEffect(() => {
    if (!token || !info) return;
    const s = new PartySocket(
      token,
      (m) => {
        if (m.type === "welcome" || m.type === "info") {
          const { type: _t, role: _r, ...rest } = m;
          setInfo(rest as PartyInfo);
          lastState.current = ""; // the server forgets nothing, but resend once after reconnects
        } else if (m.type === "guests") setInfo((i) => (i ? { ...i, guests: m.guests } : i));
        else if (m.type === "queue") onQueueRef.current();
        else if (m.type === "cmd") handler.current?.(m as unknown as Command & { by: string });
        else if (m.type === "ended") forget();
      },
      setConnected,
    );
    socket.current = s;
    const wake = () => document.visibilityState === "visible" && s.nudge();
    document.addEventListener("visibilitychange", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      s.close();
      socket.current = null;
      setConnected(false);
    };
  }, [token, !!info]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback(
    async (force = false) => {
      setError("");
      try {
        const r = await partyApi.start(token, force);
        const { host_token, ...rest } = r;
        store(HOST_KEY, host_token);
        setToken(host_token);
        setInfo(rest);
        return "ok" as const;
      } catch (e) {
        if ((e as PartyError).status === 409) return "conflict" as const;
        setError((e as Error).message);
        return "ok" as const;
      }
    },
    [token],
  );

  const run = useCallback(
    async (fn: (t: string) => Promise<unknown>) => {
      if (!token) return;
      setError("");
      try {
        await fn(token);
      } catch (e) {
        if ((e as PartyError).status === 401) forget();
        else setError((e as Error).message);
      }
    },
    [token, forget],
  );

  const end = useCallback(() => run(async (t) => {
    await partyApi.end(t);
    forget();
  }), [run, forget]);
  const newCode = useCallback(() => run(async (t) => setInfo(await partyApi.newCode(t))), [run]);
  const kick = useCallback((id: string) => run(async (t) => setInfo(await partyApi.kick(t, id))), [run]);

  const publish = useCallback((s: StageState) => {
    const json = JSON.stringify(s);
    if (json === lastState.current) return;
    if (socket.current?.send({ type: "state", state: s })) lastState.current = json;
  }, []);

  const setHandler = useCallback((fn: ((c: Command & { by: string }) => void) | null) => {
    handler.current = fn;
  }, []);

  return { info, connected, error, start, end, newCode, kick, publish, setHandler };
}
