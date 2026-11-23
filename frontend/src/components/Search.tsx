import { useEffect, useRef, useState } from "react";
import { api, fmtTime, statusLabel, type SearchResult, type Song } from "../api";
import { Icon } from "./Icon";

interface Props {
  songs: Song[];
  onPlay: (id: string) => void;
  onChanged: () => void;
  askSinger: () => Promise<string | null>;
}

export function Search({ songs, onPlay, onChanged, askSinger }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const id = window.setTimeout(async () => {
      const n = ++seq.current;
      setBusy(true);
      setError("");
      try {
        const r = await api.search(term);
        if (n === seq.current) setResults(r);
      } catch (e) {
        if (n === seq.current) setError((e as Error).message);
      } finally {
        if (n === seq.current) setBusy(false);
      }
    }, 450);
    return () => window.clearTimeout(id);
  }, [q]);

  const byId = new Map(songs.map((s) => [s.id, s]));

  const add = async (r: SearchResult, queue: boolean) => {
    let singer: string | undefined;
    if (queue) {
      const s = await askSinger();
      if (s === null) return;
      singer = s;
    }
    try {
      const { thumb: _thumb, status: _status, ...meta } = r;
      await api.add({ ...meta, singer });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="searchbar">
        <Icon name="search" />
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search YouTube Music, or paste a YouTube link"
          spellCheck={false}
        />
        {busy && <span className="spinner" />}
      </div>
      {error && <div className="alert">{error}</div>}
      {!q && (
        <div className="hint">
          Songs you add get downloaded, split into vocals and instrumental by an AI model (Demucs), and get synced lyrics.
          After that they stay in your library and start instantly.
        </div>
      )}
      <div className="results">
        {results.map((r) => {
          const lib = byId.get(r.id);
          return (
            <div className="result" key={r.id}>
              <img src={r.thumb} alt="" loading="lazy" />
              <div className="result-text">
                <div className="result-title">{r.title}</div>
                <div className="muted">
                  {r.artist}
                  {r.album ? ` · ${r.album}` : ""}
                  {r.duration ? ` · ${fmtTime(r.duration)}` : ""}
                </div>
                {lib && lib.status !== "ready" && (
                  <div className={`pill ${lib.status}`}>{statusLabel(lib)}</div>
                )}
              </div>
              <div className="result-actions">
                {lib?.status === "ready" ? (
                  <button className="btn primary" onClick={() => onPlay(r.id)}>
                    <Icon name="play" size={16} /> Sing
                  </button>
                ) : !lib ? (
                  <button className="btn" onClick={() => add(r, false)} title="Prepare it for the library">
                    <Icon name="plus" size={16} /> Add
                  </button>
                ) : lib.status === "error" ? (
                  <button className="btn" onClick={() => add(r, false)}>
                    <Icon name="refresh" size={16} /> Retry
                  </button>
                ) : null}
                <button className="btn ghost" onClick={() => add(r, true)} title="Add and put it in the party queue">
                  <Icon name="queue" size={16} /> Queue
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
