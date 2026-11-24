import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtTime, type Background as Bg, type BackgroundMode, type QueueEntry, type Settings, type SongDetail } from "../api";
import { prefetchStems, StemPlayer } from "../audio";
import { DEFAULT_PALETTE, paletteFrom, type RGB } from "../palette";
import { Background } from "./Background";
import { Icon } from "./Icon";
import { Lyrics } from "./Lyrics";

export interface NowPlaying {
  songId: string;
  singer: string;
  key: number; // changes for every new play, even of the same song
}

interface Props {
  now: NowPlaying | null;
  online: boolean;
  settings: Settings;
  queue: QueueEntry[];
  backgrounds: Bg[];
  onPlayNext: () => void; // take the next entry off the queue and play it
  onIdle: () => void;
  onChrome: (visible: boolean) => void;
}

const BG_OPTIONS: { mode: BackgroundMode; icon: string; label: string }[] = [
  { mode: "aurora", icon: "sparkle", label: "Aurora" },
  { mode: "visualizer", icon: "wave", label: "Visualizer" },
  { mode: "cover", icon: "disc", label: "Cover art" },
  { mode: "video", icon: "video", label: "Music video" },
  { mode: "custom", icon: "image", label: "Your background" },
];

export function Stage({ now, online, settings, queue, backgrounds, onPlayNext, onIdle, onChrome }: Props) {
  const [song, setSong] = useState<SongDetail | null>(null);
  const [player, setPlayer] = useState<StemPlayer | null>(null);
  const [loadPct, setLoadPct] = useState(0);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [vocals, setVocals] = useState(settings.default_vocals);
  const [volume, setVolume] = useState(1);
  const [bg, setBg] = useState<BackgroundMode>(settings.default_background);
  const [offset, setOffset] = useState(0);
  const [palette, setPalette] = useState<RGB[]>(DEFAULT_PALETTE);
  const [chrome, setChrome] = useState(true);
  const [ended, setEnded] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [blocked, setBlocked] = useState(false); // iOS wants a tap before it plays sound
  const prefetchedFor = useRef("");
  const offsetRef = useRef(0);
  const hideTimer = useRef<number>(0);
  const seeking = useRef(false);

  const nextUp = queue.find((q) => q.status === "ready");
  const custom = backgrounds.find((b) => b.name === settings.custom_background) ?? backgrounds[0] ?? null;

  // ---- load song + stems ----
  useEffect(() => {
    setSong(null);
    setError("");
    setEnded(false);
    setCountdown(null);
    setPlaying(false);
    setBlocked(false);
    setPos(0);
    if (!now) return;
    let cancelled = false;
    const p = new StemPlayer();
    (async () => {
      try {
        const s = await api.song(now.songId);
        if (cancelled) return;
        if (!s.stems) throw new Error("This song is not processed yet.");
        setSong(s);
        setOffset(s.lyrics_offset || 0);
        offsetRef.current = s.lyrics_offset || 0;
        paletteFrom(s.cover).then((pal) => !cancelled && setPalette(pal));
        setLoadPct(0);
        await p.load(s.stems.instrumental, s.stems.vocals, (f) => !cancelled && setLoadPct(f));
        if (cancelled) return;
        p.onEnded = () => {
          setPlaying(false);
          setEnded(true);
        };
        p.onBlocked = setBlocked;
        setPlayer(p);
        const started = await p.play();
        if (cancelled) return;
        setPlaying(p.playing);
        setBlocked(!started);
        void api.played(s.id).catch(() => {});
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      p.destroy();
      setPlayer(null);
    };
  }, [now]);

  useEffect(() => setVocals(settings.default_vocals), [settings.default_vocals, now]);
  useEffect(() => setBg(settings.default_background), [settings.default_background]);
  useEffect(() => player?.setVocals(vocals), [player, vocals]);
  useEffect(() => player?.setVolume(volume), [player, volume]);

  // ---- position ticker for the seek bar ----
  useEffect(() => {
    if (!player) return;
    const id = window.setInterval(() => {
      if (!seeking.current) setPos(player.currentTime);
    }, 250);
    return () => window.clearInterval(id);
  }, [player]);

  // ---- preload the next song's stems while this one plays ----
  const nextId = nextUp?.song_id ?? "";
  useEffect(() => {
    if (!settings.preload_next) {
      prefetchedFor.current = "";
      prefetchStems([]);
      return;
    }
    if (!online || !player?.playing || !nextId || prefetchedFor.current === nextId) return;
    if (pos < Math.min(15, player.duration / 2)) return;
    prefetchedFor.current = nextId;
    api
      .song(nextId)
      .then((s) => s.stems && prefetchStems([s.stems.instrumental, s.stems.vocals]))
      .catch(() => (prefetchedFor.current = ""));
  }, [pos, nextId, settings.preload_next, online, player]);

  // ---- auto advance ----
  useEffect(() => {
    if (!ended) return;
    if (!settings.auto_advance || !nextUp) {
      setCountdown(null);
      return;
    }
    setCountdown(settings.countdown_seconds);
  }, [ended]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      setCountdown(null);
      onPlayNext();
      return;
    }
    const id = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [countdown, onPlayNext]);

  // ---- auto-hide controls ----
  const poke = useCallback(() => {
    setChrome(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setChrome(false), 3200);
  }, []);
  useEffect(() => {
    if (!playing) {
      window.clearTimeout(hideTimer.current);
      setChrome(true);
    } else poke();
  }, [playing, poke]);
  useEffect(() => onChrome(chrome || !now), [chrome, now, onChrome]);

  const toggle = useCallback(() => {
    if (!player) return;
    if (ended) setEnded(false);
    if (player.playing && !blocked) {
      player.pause();
      setPlaying(false);
      return;
    }
    // Called straight from the tap, so iOS lets the audio start.
    void player.play().then((ok) => {
      setPlaying(player.playing);
      setBlocked(!ok);
    });
  }, [player, ended, blocked]);

  const saveOffset = useRef<number>(0);
  const changeOffset = useCallback(
    (delta: number) => {
      if (!song) return;
      const v = Math.round((offsetRef.current + delta) * 10) / 10;
      offsetRef.current = v;
      setOffset(v);
      window.clearTimeout(saveOffset.current);
      saveOffset.current = window.setTimeout(() => void api.patch(song.id, { lyrics_offset: v }).catch(() => {}), 600);
    },
    [song],
  );

  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  };

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      if (!player) return;
      poke();
      switch (e.key) {
        case " ":
          e.preventDefault();
          toggle();
          break;
        case "ArrowLeft":
          player.seek(player.currentTime - 5);
          break;
        case "ArrowRight":
          player.seek(player.currentTime + 5);
          break;
        case "ArrowUp":
          e.preventDefault();
          setVocals((v) => Math.min(1, Math.round((v + 0.1) * 10) / 10));
          break;
        case "ArrowDown":
          e.preventDefault();
          setVocals((v) => Math.max(0, Math.round((v - 0.1) * 10) / 10));
          break;
        case "f":
          fullscreen();
          break;
        case "b": {
          const i = BG_OPTIONS.findIndex((o) => o.mode === bg);
          setBg(BG_OPTIONS[(i + 1) % BG_OPTIONS.length].mode);
          break;
        }
        case "[":
          changeOffset(-0.1);
          break;
        case "]":
          changeOffset(0.1);
          break;
        case "n":
          if (nextUp) onPlayNext();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player, toggle, poke, bg, changeOffset, nextUp, onPlayNext]);

  const lyricTime = useCallback(() => (player ? player.currentTime + offsetRef.current : 0), [player]);

  // ---- empty stage ----
  if (!now) {
    return (
      <div className="stage" onMouseMove={poke}>
        <Background mode={bg === "video" ? "aurora" : bg} cover="" video={null} custom={online ? custom : null} player={null} palette={DEFAULT_PALETTE} />
        <div className="stage-empty">
          <div className="hero-word">encore</div>
          <p>Pick a song from the library or search for one. Phones on the same network can open this page and add songs to the queue.</p>
          {nextUp ? (
            <button className="btn primary big" onClick={onPlayNext}>
              <Icon name="play" /> Start the queue: {nextUp.title}
              {nextUp.singer ? ` (${nextUp.singer})` : ""}
            </button>
          ) : (
            <button className="btn primary big" onClick={onIdle}>
              <Icon name="search" /> Find a song
            </button>
          )}
        </div>
      </div>
    );
  }

  const duration = player?.duration || song?.duration || 0;
  const vocPct = Math.round(vocals * 100);

  return (
    <div className={`stage ${chrome ? "" : "chrome-hidden"}`} onMouseMove={poke} onTouchStart={poke}>
      <Background mode={bg} cover={song?.cover ?? ""} video={online ? song?.video : null} custom={online ? custom : null} player={player} palette={palette} />

      {song && player && (
        <Lyrics
          lines={song.lyrics}
          synced={!!song.lyrics_synced}
          time={lyricTime}
          duration={duration}
          title={song.title}
          artist={song.artist}
          singer={now.singer}
          scale={settings.lyrics_font_scale}
        />
      )}

      {!player && !error && (
        <div className="loading">
          {song && <img src={song.cover} alt="" className="loading-cover" />}
          <div className="loading-title">{song ? `${song.title}` : "Loading"}</div>
          <div className="bar"><span style={{ width: `${Math.round(loadPct * 100)}%` }} /></div>
        </div>
      )}
      {error && (
        <div className="loading">
          <div className="loading-title">Could not start this song</div>
          <p className="muted">{error}</p>
        </div>
      )}

      {song && (
        <div className="stage-top">
          <div className="np">
            <img src={song.cover} alt="" />
            <div>
              <div className="np-title">{song.title}</div>
              <div className="np-artist">
                {song.artist}
                {now.singer ? <span className="np-singer"> · sung by {now.singer}</span> : null}
              </div>
            </div>
          </div>
          {nextUp && (
            <div className="upnext">
              <span className="muted">Up next</span>
              <b>{nextUp.singer || "Someone"}</b>
              <span>{nextUp.title}</span>
            </div>
          )}
        </div>
      )}

      {countdown !== null && nextUp && (
        <div className="countdown">
          <div className="muted">Next up</div>
          <div className="cd-singer">{nextUp.singer || "Next singer"}</div>
          <div className="cd-song">{nextUp.title} · {nextUp.artist}</div>
          <div className="cd-num">{countdown}</div>
          <div className="row">
            <button className="btn primary" onClick={() => { setCountdown(null); onPlayNext(); }}>Start now</button>
            <button className="btn" onClick={() => setCountdown(null)}>Wait</button>
          </div>
        </div>
      )}

      {blocked && player && countdown === null && (
        <button className="tap-to-play" onClick={toggle}>
          <span className="tap-icon"><Icon name="play" size={40} /></span>
          <span className="tap-title">Tap to {pos > 0.5 ? "continue" : "start"}</span>
          <span className="muted">The browser holds the sound until you tap.</span>
        </button>
      )}

      {player && (
        <div className="controls" onMouseMove={(e) => e.stopPropagation()} onMouseEnter={() => { window.clearTimeout(hideTimer.current); setChrome(true); }} onMouseLeave={poke}>
          <div className="seek">
            <span className="time">{fmtTime(pos)}</span>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.1}
              value={pos}
              onPointerDown={() => (seeking.current = true)}
              onChange={(e) => setPos(Number(e.target.value))}
              onPointerUp={(e) => {
                seeking.current = false;
                player.seek(Number((e.target as HTMLInputElement).value));
              }}
              onKeyUp={(e) => player.seek(Number((e.target as HTMLInputElement).value))}
              style={{ "--v": `${(pos / (duration || 1)) * 100}%` } as React.CSSProperties}
            />
            <span className="time">{fmtTime(duration)}</span>
          </div>
          <div className="controls-row">
            <div className="group">
              <button className="icon-btn play" onClick={toggle} title="Play / pause (space)">
                <Icon name={playing ? "pause" : "play"} size={26} />
              </button>
              <button className="icon-btn" onClick={onPlayNext} disabled={!nextUp} title="Next in queue (n)">
                <Icon name="next" />
              </button>
            </div>

            <label className="slider vocals" title="Guide vocals (arrow up/down)">
              <Icon name={vocals === 0 ? "micOff" : "mic"} />
              <span className="slider-label">Vocals</span>
              <input
                type="range" min={0} max={1} step={0.01} value={vocals}
                onChange={(e) => setVocals(Number(e.target.value))}
                style={{ "--v": `${vocPct}%` } as React.CSSProperties}
              />
              <span className="slider-val">{vocPct}%</span>
            </label>

            <label className="slider volume" title="Volume">
              <Icon name="volume" />
              <input
                type="range" min={0} max={1} step={0.01} value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                style={{ "--v": `${volume * 100}%` } as React.CSSProperties}
              />
            </label>

            <div className="group bgpick" title="Background (b)">
              {BG_OPTIONS.map((o) => {
                const unavailable = (o.mode === "video" && (!song?.video || !online)) || (o.mode === "custom" && (!custom || !online));
                return (
                  <button
                    key={o.mode}
                    className={`icon-btn ${bg === o.mode ? "on" : ""}`}
                    onClick={() => setBg(o.mode)}
                    disabled={unavailable}
                    title={unavailable ? `${o.label} (not available)` : o.label}
                  >
                    <Icon name={o.icon} size={18} />
                  </button>
                );
              })}
            </div>

            <div className="group offset" title="Lyrics timing ([ and ])">
              <button className="icon-btn small" onClick={() => changeOffset(-0.1)}>−</button>
              <span className="offset-val">{offset > 0 ? "+" : ""}{offset.toFixed(1)}s</span>
              <button className="icon-btn small" onClick={() => changeOffset(0.1)}>+</button>
            </div>

            {document.fullscreenEnabled && (
              <button className="icon-btn" onClick={fullscreen} title="Fullscreen (f)">
                <Icon name="fullscreen" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
