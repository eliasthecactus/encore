import { useCallback, useEffect, useRef, useState } from "react";
import { fmtTime, statusLabel, type BackgroundMode, type SearchResult } from "../api";
import { Icon } from "../components/Icon";
import {
  formatCode,
  partyApi,
  PartySocket,
  store,
  stored,
  type Command,
  type GuestQueueEntry,
  type LibrarySong,
  type PartyRole,
  type PartyError,
  type PartyMessage,
  type StageState,
} from "../party";

const GUEST_KEY = "encore.guest";

interface Session {
  token: string;
  name: string;
  role?: PartyRole; // last known, the server sends the current one
}

const ENDED: Record<string, string> = {
  ended: "The party has ended.",
  replaced: "The party has ended.",
  expired: "The party has ended.",
  removed: "The host removed you from the party.",
  "no-party": "The party has ended.",
  unauthorized: "Your invitation is no longer valid. Join again with the current code.",
};

export function GuestApp() {
  const [session, setSession] = useState<Session | null>(() => stored<Session>(GUEST_KEY));
  const [notice, setNotice] = useState("");

  const leave = useCallback((message = "") => {
    store(GUEST_KEY, null);
    setSession(null);
    setNotice(message);
  }, []);

  return session ? (
    <Remote session={session} onLeave={leave} />
  ) : (
    <Join
      notice={notice}
      onJoined={(s) => {
        store(GUEST_KEY, s);
        setNotice("");
        setSession(s);
      }}
    />
  );
}

// ---- join ----------------------------------------------------------------------------

function Join({ notice, onJoined }: { notice: string; onJoined: (s: Session) => void }) {
  const [code, setCode] = useState(() => formatCode(location.hash.replace(/\D/g, "")));
  const [name, setName] = useState(() => stored<string>("encore.guest-name") ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<boolean | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    partyApi.status().then((s) => setActive(s.active), () => setActive(null));
    // the code from a scanned QR code should not stay in the address bar
    if (location.hash) history.replaceState(null, "", location.pathname);
    (code.replace(/\D/g, "").length === 6 ? nameInput : codeInput).current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const digits = code.replace(/\D/g, "");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (digits.length !== 6 || !name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await partyApi.join(digits, name.trim());
      store("encore.guest-name", r.guest.name);
      onJoined({ token: r.token, name: r.guest.name, role: r.guest.role });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="guest join-screen">
      <form className="join-card" onSubmit={submit}>
        <img src="/favicon.svg" alt="" width={56} height={56} />
        <div className="hero-word small">encore</div>
        <p className="muted">Join the karaoke party with the code on the big screen.</p>
        {notice && <div className="alert">{notice}</div>}
        {active === false && !notice && <div className="hint">No party is running right now. Ask the host to start one under Party.</div>}
        <label className="field">
          <span>Party code</span>
          <input
            ref={codeInput}
            className="code-input"
            value={code}
            onChange={(e) => setCode(formatCode(e.target.value))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123 456"
            maxLength={7}
            aria-label="Party code, 6 digits"
          />
        </label>
        <label className="field">
          <span>Your name</span>
          <input ref={nameInput} value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder="So the others know who sings" autoComplete="nickname" />
        </label>
        {error && <div className="alert">{error}</div>}
        <button className="btn primary big" type="submit" disabled={digits.length !== 6 || !name.trim() || busy}>
          {busy ? <span className="spinner" /> : <Icon name="users" />} Join
        </button>
      </form>
    </div>
  );
}

// ---- remote ----------------------------------------------------------------------------

type Tab = "now" | "queue" | "add";

const BG: { mode: BackgroundMode; icon: string; label: string }[] = [
  { mode: "aurora", icon: "sparkle", label: "Aurora" },
  { mode: "visualizer", icon: "wave", label: "Visualizer" },
  { mode: "cover", icon: "disc", label: "Cover" },
  { mode: "video", icon: "video", label: "Video" },
  { mode: "custom", icon: "image", label: "Custom" },
];

function Remote({ session, onLeave }: { session: Session; onLeave: (msg?: string) => void }) {
  const [tab, setTab] = useState<Tab>("now");
  const [stage, setStage] = useState<Partial<StageState>>({});
  const [stageAt, setStageAt] = useState(0);
  const [hostOnline, setHostOnline] = useState(true);
  const [connected, setConnected] = useState(false);
  const [role, setRole] = useState<PartyRole>(session.role ?? "member");
  const [queue, setQueue] = useState<GuestQueueEntry[]>([]);
  const [toast, setToast] = useState("");
  const socket = useRef<PartySocket | null>(null);
  const token = session.token;

  const flash = useCallback((msg: string) => setToast(msg), []);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(id);
  }, [toast]);

  const changeRole = useCallback(
    (r: PartyRole, announce: boolean) => {
      setRole((old) => {
        if (announce && old !== r) {
          flash(r === "admin" ? "You are now a party admin: you can control the music" : "You are now a member: you can add songs");
        }
        return r;
      });
      store(GUEST_KEY, { ...session, role: r });
    },
    [session, flash],
  );

  const refreshQueue = useCallback(() => {
    partyApi.queue(token).then(setQueue, (e: PartyError) => e.status === 401 && onLeave(ENDED.unauthorized));
  }, [token, onLeave]);

  useEffect(() => {
    partyApi.me(token).then(
      (r) => {
        setStage(r.state);
        setStageAt(performance.now());
        setHostOnline(r.host_online);
        changeRole(r.guest.role, false);
      },
      (e: PartyError) => e.status === 401 && onLeave(ENDED.unauthorized),
    );
    refreshQueue();
    const s = new PartySocket(
      token,
      (m: PartyMessage) => {
        if (m.type === "state") {
          setStage(m.state ?? {});
          setStageAt(performance.now());
          setHostOnline(!!m.host_online);
        } else if (m.type === "welcome") changeRole(m.guest.role, false);
        else if (m.type === "role") changeRole(m.guest.role, true);
        else if (m.type === "queue") refreshQueue();
        else if (m.type === "error") flash(m.detail);
        else if (m.type === "ended") onLeave(ENDED[m.reason] ?? ENDED.ended);
      },
      setConnected,
    );
    socket.current = s;
    // Phones suspend background tabs: reconnect and catch up when it is visible again.
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      s.nudge();
      refreshQueue();
    };
    document.addEventListener("visibilitychange", wake);
    // processing progress of queued songs is not pushed, so look again now and then
    const poll = window.setInterval(() => document.visibilityState === "visible" && refreshQueue(), 5000);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.clearInterval(poll);
      s.close();
    };
  }, [token, refreshQueue, onLeave, flash, changeRole]);

  const send = useCallback(
    (c: Command) => {
      if (!socket.current?.send({ type: "cmd", ...c })) flash("Not connected, trying again…");
    },
    [flash],
  );

  const leave = async () => {
    if (!confirm("Leave the party?")) return;
    await partyApi.leave(token).catch(() => {});
    onLeave();
  };

  const mine = queue.filter((q) => q.mine).length;

  return (
    <div className="guest">
      <header className="guest-head">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <div className="grow">
          <div className="guest-title">Party</div>
          <div className="muted small">
            <span className={`dot ${connected && hostOnline ? "on" : ""}`} />{" "}
            {!connected ? "Connecting…" : hostOnline ? `${session.name} · ${role === "admin" ? "Admin" : "Member"}` : "The big screen is offline"}
          </div>
        </div>
        <button className="icon-btn small" onClick={leave} aria-label="Leave the party" title="Leave the party">
          <Icon name="logout" size={18} />
        </button>
      </header>

      <main className="guest-main">
        {tab === "now" && <NowPlaying stage={stage} stageAt={stageAt} send={send} queue={queue} onAdd={() => setTab("add")} admin={role === "admin"} />}
        {tab === "queue" && <GuestQueue queue={queue} token={token} onChanged={refreshQueue} onAdd={() => setTab("add")} flash={flash} />}
        {tab === "add" && <AddSongs token={token} name={session.name} flash={flash} onAdded={refreshQueue} />}
      </main>

      {toast && <div className="guest-toast" role="status">{toast}</div>}

      <nav className="guest-tabs">
        <button className={tab === "now" ? "on" : ""} onClick={() => setTab("now")}>
          <Icon name="mic" /> <span>{role === "admin" ? "Remote" : "Now"}</span>
        </button>
        <button className={tab === "queue" ? "on" : ""} onClick={() => setTab("queue")}>
          <Icon name="queue" /> <span>Queue{queue.length ? ` (${queue.length})` : ""}</span>
          {mine > 0 && <span className="count">{mine}</span>}
        </button>
        <button className={tab === "add" ? "on" : ""} onClick={() => setTab("add")}>
          <Icon name="plus" /> <span>Add song</span>
        </button>
      </nav>
    </div>
  );
}

/** A slider that follows the stage, except while the guest drags it. Sends at most every 120 ms. */
function useRemoteValue(remote: number | undefined, sendValue: (v: number) => void) {
  const [draft, setDraft] = useState<number | null>(null);
  const last = useRef(0);
  const pending = useRef<number | null>(null);
  const timer = useRef(0);
  const release = useRef(0);
  const change = (v: number) => {
    setDraft(v);
    pending.current = v;
    window.clearTimeout(release.current);
    release.current = window.setTimeout(() => setDraft(null), 1500); // then trust the stage again
    const wait = 120 - (Date.now() - last.current);
    if (wait <= 0) {
      last.current = Date.now();
      sendValue(v);
      pending.current = null;
    } else {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        last.current = Date.now();
        if (pending.current !== null) sendValue(pending.current);
        pending.current = null;
      }, wait);
    }
  };
  return [draft ?? remote ?? 0, change] as const;
}

function NowPlaying({
  stage, stageAt, send, queue, onAdd, admin,
}: {
  stage: Partial<StageState>;
  stageAt: number;
  send: (c: Command) => void;
  queue: GuestQueueEntry[];
  onAdd: () => void;
  admin: boolean;
}) {
  const [, tick] = useState(0);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => setCoverFailed(false), [stage.song?.cover]);
  const [vocals, setVocals] = useRemoteValue(stage.vocals, (v) => send({ action: "vocals", value: v }));
  const [volume, setVolume] = useRemoteValue(stage.volume, (v) => send({ action: "volume", value: v }));

  useEffect(() => {
    if (!stage.playing) return;
    const id = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [stage.playing]);

  const duration = stage.duration ?? 0;
  const livePos = Math.min(duration, (stage.pos ?? 0) + (stage.playing ? (performance.now() - stageAt) / 1000 : 0));
  const pos = seekDraft ?? livePos;
  const ready = queue.find((q) => q.status === "ready");

  if (!stage.song) {
    return (
      <div className="guest-idle">
        <Icon name="mic" size={40} />
        <h2>{stage.loading ? "Loading the song…" : "Nothing is playing"}</h2>
        {ready ? (
          <>
            <p className="muted">Next: {ready.title}{ready.singer ? ` (${ready.singer})` : ""}</p>
            {admin ? (
              <button className="btn primary big" onClick={() => send({ action: "play" })}>
                <Icon name="play" /> Start the queue
              </button>
            ) : (
              <p className="muted small">A party admin or the big screen starts it.</p>
            )}
          </>
        ) : (
          <>
            <p className="muted">Add a song and it starts as soon as it is ready.</p>
            <button className="btn primary big" onClick={onAdd}><Icon name="plus" /> Add a song</button>
          </>
        )}
      </div>
    );
  }

  const vocPct = Math.round(vocals * 100);
  return (
    <div className="remote">
      <div className="remote-song">
        {stage.song.cover && !coverFailed ? (
          <img src={stage.song.cover} alt="" onError={() => setCoverFailed(true)} />
        ) : (
          <div className="cover-ph"><Icon name="disc" size={56} /></div>
        )}
        <div className="remote-title">{stage.song.title}</div>
        <div className="muted">
          {stage.song.artist}
          {stage.singer ? ` · sung by ${stage.singer}` : ""}
        </div>
      </div>

      {stage.countdown != null && stage.nextUp && (
        <div className="hint">
          Next up in {stage.countdown}s: <b>{stage.nextUp.singer || "Someone"}</b> with {stage.nextUp.title}
        </div>
      )}
      {stage.blocked && <div className="hint">The big screen needs one tap before the sound can start.</div>}

      {!admin && (
        <>
          <div className="seek readonly">
            <span className="time">{fmtTime(pos)}</span>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Math.round(pos)}>
              <span style={{ width: `${(pos / (duration || 1)) * 100}%` }} />
            </div>
            <span className="time">{fmtTime(duration)}</span>
          </div>
          {stage.nextUp && (
            <div className="next-card">
              <span className="muted small">Up next</span>
              <b>{stage.nextUp.singer || "Someone"}</b>
              <span className="muted ellipsis">{stage.nextUp.title}</span>
            </div>
          )}
          <p className="muted small member-note">
            You can add songs and remove your own. Party admins control the music.
          </p>
          <button className="btn primary big" onClick={onAdd}><Icon name="plus" /> Add a song</button>
        </>
      )}

      {admin && (<>
      <div className="seek">
        <span className="time">{fmtTime(pos)}</span>
        <input
          type="range" min={0} max={duration || 1} step={0.5} value={pos}
          onChange={(e) => setSeekDraft(Number(e.target.value))}
          onPointerUp={(e) => {
            send({ action: "seek", value: Number((e.target as HTMLInputElement).value) });
            window.setTimeout(() => setSeekDraft(null), 800);
          }}
          onKeyUp={(e) => send({ action: "seek", value: Number((e.target as HTMLInputElement).value) })}
          style={{ "--v": `${(pos / (duration || 1)) * 100}%` } as React.CSSProperties}
          aria-label="Position"
        />
        <span className="time">{fmtTime(duration)}</span>
      </div>

      <div className="remote-buttons">
        <button className="icon-btn" onClick={() => send({ action: "restart" })} aria-label="From the start"><Icon name="restart" /></button>
        <button className="icon-btn" onClick={() => send({ action: "skip", value: -10 })} aria-label="Back 10 seconds"><Icon name="rewind" /></button>
        <button className="icon-btn play" onClick={() => send({ action: "toggle" })} aria-label={stage.playing ? "Pause" : "Play"}>
          <Icon name={stage.playing ? "pause" : "play"} size={30} />
        </button>
        <button className="icon-btn" onClick={() => send({ action: "skip", value: 10 })} aria-label="Forward 10 seconds"><Icon name="forward" /></button>
        <button className="icon-btn" onClick={() => send({ action: "next" })} disabled={!stage.nextUp} aria-label="Next song"><Icon name="next" /></button>
      </div>

      <label className="slider vocals">
        <Icon name={vocals === 0 ? "micOff" : "mic"} />
        <span className="slider-label">Vocals</span>
        <input
          type="range" min={0} max={1} step={0.01} value={vocals}
          onChange={(e) => setVocals(Number(e.target.value))}
          style={{ "--v": `${vocPct}%` } as React.CSSProperties}
        />
        <span className="slider-val">{vocPct}%</span>
      </label>

      <label className="slider vocals">
        <Icon name="volume" />
        <span className="slider-label">Volume</span>
        <input
          type="range" min={0} max={1} step={0.01} value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          style={{ "--v": `${Math.round(volume * 100)}%` } as React.CSSProperties}
        />
        <span className="slider-val">{Math.round(volume * 100)}%</span>
      </label>

      <div className="remote-bg">
        {BG.map((o) => (
          <button
            key={o.mode}
            className={`bg-chip ${stage.bg === o.mode ? "on" : ""}`}
            disabled={!stage.bgAvailable?.includes(o.mode)}
            onClick={() => send({ action: "background", value: o.mode })}
          >
            <Icon name={o.icon} size={18} />
            <span>{o.label}</span>
          </button>
        ))}
      </div>
      </>)}
    </div>
  );
}

function GuestQueue({
  queue, token, onChanged, onAdd, flash,
}: {
  queue: GuestQueueEntry[];
  token: string;
  onChanged: () => void;
  onAdd: () => void;
  flash: (m: string) => void;
}) {
  if (!queue.length) {
    return (
      <div className="guest-idle">
        <Icon name="queue" size={40} />
        <h2>The queue is empty</h2>
        <button className="btn primary big" onClick={onAdd}><Icon name="plus" /> Add a song</button>
      </div>
    );
  }
  return (
    <div className="queue">
      {queue.map((q, i) => (
        <div className={`qrow ${q.mine ? "mine" : ""}`} key={q.id}>
          <div className="qnum">{i + 1}</div>
          <img src={q.cover} alt="" />
          <div className="grow">
            <div className="qsinger">{q.singer || "Anyone"}{q.mine && <span className="mine-tag">you added</span>}</div>
            <div className="muted small ellipsis">{q.title} · {q.artist}{q.duration ? ` · ${fmtTime(q.duration)}` : ""}</div>
            {q.status !== "ready" && <div className={`pill ${q.status}`}>{statusLabel(q)}</div>}
          </div>
          {q.mine && (
            <button
              className="icon-btn small"
              aria-label="Remove"
              onClick={async () => {
                try {
                  await partyApi.remove(token, q.id);
                  onChanged();
                } catch (e) {
                  flash((e as Error).message);
                }
              }}
            >
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

type LibSort = "popular" | "new" | "az";

/** Lowercase without accents, so "beyonce" finds "Beyoncé". */
function fold(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function AddSongs({ token, name, flash, onAdded }: { token: string; name: string; flash: (m: string) => void; onAdded: () => void }) {
  const [q, setQ] = useState("");
  const [singer, setSinger] = useState(name);
  const [library, setLibrary] = useState<LibrarySong[] | null>(null);
  const [sort, setSort] = useState<LibSort>(() => stored<LibSort>("encore.guest-sort") ?? "popular");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  useEffect(() => {
    partyApi.library(token).then(setLibrary, () => setLibrary([]));
  }, [token]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setBusy(false);
      return;
    }
    const id = window.setTimeout(async () => {
      const n = ++seq.current;
      setBusy(true);
      setError("");
      try {
        const r = await partyApi.search(token, term);
        if (n === seq.current) setResults(r);
      } catch (e) {
        if (n === seq.current) setError((e as Error).message);
      } finally {
        if (n === seq.current) setBusy(false);
      }
    }, 500);
    return () => window.clearTimeout(id);
  }, [q, token]);

  const add = async (song: { id: string; title: string } & Partial<SearchResult>, ready: boolean) => {
    try {
      const { thumb: _t, status: _s, ...meta } = song as SearchResult;
      await partyApi.add(token, ready ? { id: song.id } : meta, singer.trim());
      setAdded((s) => new Set(s).add(song.id));
      flash(ready ? `${song.title} is in the queue` : `${song.title} is in the queue and gets prepared now`);
      onAdded();
    } catch (e) {
      flash((e as Error).message);
    }
  };

  const term = fold(q.trim());
  const libIds = new Set((library ?? []).map((s) => s.id));
  const libShown = (library ?? [])
    .filter((s) => !term || fold(`${s.title} ${s.artist} ${s.album}`).includes(term))
    .sort((a, b) =>
      sort === "az"
        ? a.title.localeCompare(b.title)
        : sort === "new"
          ? b.created_at - a.created_at
          : b.play_count - a.play_count || (b.last_played_at ?? 0) - (a.last_played_at ?? 0),
    );
  const webShown = results.filter((r) => !libIds.has(r.id));
  const pickSort = (v: LibSort) => {
    setSort(v);
    store("encore.guest-sort", v);
  };

  const addButton = (id: string, onClick: () => void, label: string) => (
    <button className={`btn add-btn ${added.has(id) ? "done" : "primary"}`} onClick={onClick} aria-label={label}>
      <Icon name={added.has(id) ? "check" : "plus"} size={18} />
    </button>
  );

  return (
    <div className="add-songs">
      <div className="searchbar">
        <Icon name="search" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Song, artist or YouTube link" spellCheck={false} enterKeyHint="search" />
        {busy ? <span className="spinner" /> : q && (
          <button className="icon-btn small" onClick={() => setQ("")} aria-label="Clear search"><Icon name="x" size={16} /></button>
        )}
      </div>
      <label className="singer-chip">
        <Icon name="mic" size={16} />
        <span>Singer</span>
        <input value={singer} onChange={(e) => setSinger(e.target.value)} maxLength={24} placeholder={name} />
      </label>
      {error && <div className="alert">{error}</div>}

      {(libShown.length > 0 || !term) && (
        <div className="list-head">
          <h3>In the library <span className="muted">{library ? libShown.length : ""}</span></h3>
          {!term && (library?.length ?? 0) > 1 && (
            <div className="seg" role="tablist" aria-label="Sort">
              {(["popular", "new", "az"] as LibSort[]).map((v) => (
                <button key={v} className={sort === v ? "on" : ""} onClick={() => pickSort(v)} role="tab" aria-selected={sort === v}>
                  {v === "popular" ? "Popular" : v === "new" ? "New" : "A–Z"}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {library === null && <div className="list-note"><span className="spinner" /></div>}
      {library?.length === 0 && !term && <p className="muted small list-note">The library is empty. Search for a song and it gets prepared in a minute or two.</p>}
      <div className="results">
        {libShown.map((s) => (
          <div className="result" key={s.id}>
            <img src={s.cover || "/favicon.svg"} alt="" loading="lazy" />
            <div className="result-text">
              <div className="result-title">{s.title}</div>
              <div className="muted">{s.artist}{s.duration ? ` · ${fmtTime(s.duration)}` : ""}</div>
            </div>
            <div className="result-actions">{addButton(s.id, () => add(s, true), `Add ${s.title} to the queue`)}</div>
          </div>
        ))}
      </div>

      {term.length >= 2 && (webShown.length > 0 || busy) && (
        <>
          <div className="list-head"><h3>From YouTube Music</h3></div>
          <p className="muted small list-note">New songs take a minute or two to prepare (download and vocal separation).</p>
          <div className="results">
            {webShown.map((r) => (
              <div className="result" key={r.id}>
                <img src={r.thumb} alt="" loading="lazy" />
                <div className="result-text">
                  <div className="result-title">{r.title}</div>
                  <div className="muted">{r.artist}{r.duration ? ` · ${fmtTime(r.duration)}` : ""}</div>
                  {r.status && r.status !== "ready" && <div className={`pill ${r.status}`}>{r.status === "error" ? "Failed before, adding retries" : "Being prepared"}</div>}
                </div>
                <div className="result-actions">{addButton(r.id, () => add(r, false), `Add ${r.title} to the queue`)}</div>
              </div>
            ))}
          </div>
        </>
      )}
      {term.length >= 2 && !busy && !libShown.length && !webShown.length && !error && <p className="muted list-note">Nothing found.</p>}
    </div>
  );
}
