import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Background, type ConfigResponse, type QueueEntry, type Song } from "./api";
import { audioContext } from "./audio";
import { Icon } from "./components/Icon";
import { Library } from "./components/Library";
import { Queue } from "./components/Queue";
import { Search } from "./components/Search";
import { SettingsPage } from "./components/SettingsPage";
import { Stage, type NowPlaying } from "./components/Stage";

type View = "stage" | "search" | "library" | "queue" | "settings";
const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: "stage", label: "Stage", icon: "stage" },
  { id: "search", label: "Search", icon: "search" },
  { id: "library", label: "Library", icon: "library" },
  { id: "queue", label: "Queue", icon: "queue" },
  { id: "settings", label: "Settings", icon: "settings" },
];

function viewFromHash(): View {
  const v = location.hash.replace(/^#\/?/, "").split("/")[0] as View;
  return VIEWS.some((x) => x.id === v) ? v : "library";
}

function storedSinger(): string {
  try {
    return localStorage.getItem("encore.singer") ?? "";
  } catch {
    return "";
  }
}

export function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [songs, setSongs] = useState<Song[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [backgrounds, setBackgrounds] = useState<Background[]>([]);
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [chrome, setChrome] = useState(true);
  const [singerAsk, setSingerAsk] = useState<{ resolve: (v: string | null) => void } | null>(null);
  const [singerName, setSingerName] = useState(storedSinger);
  const playKey = useRef(0);

  const go = useCallback((v: View) => {
    location.hash = `/${v}`;
    setView(v);
  }, []);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refreshSongs = useCallback(() => api.songs().then(setSongs).catch(() => {}), []);
  const refreshQueue = useCallback(() => api.queue().then(setQueue).catch(() => {}), []);
  const refreshBackgrounds = useCallback(() => api.backgrounds().then(setBackgrounds).catch(() => {}), []);
  const refresh = useCallback(() => {
    void refreshSongs();
    void refreshQueue();
  }, [refreshSongs, refreshQueue]);

  useEffect(() => {
    api.config().then(setConfig);
    refresh();
    void refreshBackgrounds();
  }, [refresh, refreshBackgrounds]);

  // Poll faster while something is being processed.
  const busy = songs.some((s) => (s.status !== "ready" && s.status !== "error") || (s.status === "ready" && !!s.stage));
  useEffect(() => {
    const id = window.setInterval(refresh, busy ? 1500 : 5000);
    return () => window.clearInterval(id);
  }, [refresh, busy]);

  const play = useCallback(
    (songId: string, singer = "") => {
      void audioContext().resume(); // unlock audio inside the click
      playKey.current += 1;
      setNow({ songId, singer, key: playKey.current });
      go("stage");
    },
    [go],
  );

  const playNext = useCallback(async () => {
    const q = await api.queue();
    const next = q.find((e) => e.status === "ready");
    if (!next) {
      setQueue(q);
      return;
    }
    await api.dequeue(next.id);
    void refreshQueue();
    play(next.song_id, next.singer);
  }, [play, refreshQueue]);

  const askSinger = useCallback(
    () => new Promise<string | null>((resolve) => setSingerAsk({ resolve })),
    [],
  );

  const answerSinger = (v: string | null) => {
    if (v !== null) {
      setSingerName(v);
      try {
        localStorage.setItem("encore.singer", v);
      } catch {
        /* private mode */
      }
    }
    singerAsk?.resolve(v);
    setSingerAsk(null);
  };

  if (!config) {
    return <div className="boot"><div className="hero-word small">encore</div></div>;
  }

  const working = songs.filter((s) => s.status !== "ready" && s.status !== "error").length;
  const onStage = view === "stage";

  return (
    <div className={`app ${onStage ? "on-stage" : ""} ${onStage && !chrome ? "nav-hidden" : ""}`}>
      <nav className="nav">
        <button className="logo" onClick={() => go("stage")}>
          <span className="logo-mark" />
          encore
        </button>
        <div className="tabs">
          {VIEWS.map((v) => (
            <button key={v.id} className={`tab ${view === v.id ? "on" : ""}`} onClick={() => go(v.id)}>
              <Icon name={v.icon} size={18} />
              <span>{v.label}</span>
              {v.id === "queue" && queue.length > 0 && <span className="count">{queue.length}</span>}
              {v.id === "library" && working > 0 && <span className="count work">{working}</span>}
            </button>
          ))}
        </div>
      </nav>

      <main className="main">
        <div className={onStage ? "view" : "view hidden"}>
          <Stage
            key={now?.key ?? 0}
            now={now}
            settings={config.settings}
            queue={queue}
            backgrounds={backgrounds}
            onPlayNext={playNext}
            onIdle={() => go("search")}
            onChrome={setChrome}
          />
        </div>
        {view === "search" && <Search songs={songs} onPlay={(id) => play(id)} onChanged={refresh} askSinger={askSinger} />}
        {view === "library" && (
          <Library songs={songs} models={config.models} onPlay={(id) => play(id)} onChanged={refresh} askSinger={askSinger} onSearch={() => go("search")} />
        )}
        {view === "queue" && <Queue queue={queue} onChanged={refresh} onStart={playNext} onSearch={() => go("search")} />}
        {view === "settings" && (
          <SettingsPage config={config} backgrounds={backgrounds} onSaved={setConfig} onBackgrounds={refreshBackgrounds} />
        )}
      </main>

      {singerAsk && (
        <div className="modal-back" onClick={() => answerSinger(null)}>
          <form
            className="modal small"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              answerSinger(singerName.trim());
            }}
          >
            <h3>Who is singing?</h3>
            <input autoFocus value={singerName} onChange={(e) => setSingerName(e.target.value)} placeholder="Name (optional)" />
            <div className="row end">
              <button type="button" className="btn ghost" onClick={() => answerSinger(null)}>Cancel</button>
              <button type="submit" className="btn primary"><Icon name="queue" size={16} /> Add to queue</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
