import { useMemo, useState } from "react";
import { api, fmtTime, STAGE_LABEL, statusLabel, type Song } from "../api";
import { Icon } from "./Icon";
import { LyricsEditor } from "./LyricsEditor";

interface Props {
  songs: Song[];
  models: Record<string, string>;
  onPlay: (id: string) => void;
  onChanged: () => void;
  askSinger: () => Promise<string | null>;
  onSearch: () => void;
}

type Sort = "recent" | "title" | "artist" | "played";

export function Library({ songs, models, onPlay, onChanged, askSinger, onSearch }: Props) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const out = songs.filter((s) => !f || `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(f));
    const cmp: Record<Sort, (a: Song, b: Song) => number> = {
      recent: (a, b) => b.created_at - a.created_at,
      title: (a, b) => a.title.localeCompare(b.title),
      artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
      played: (a, b) => b.play_count - a.play_count,
    };
    return out.sort(cmp[sort]);
  }, [songs, filter, sort]);

  const act = async (fn: () => Promise<unknown>) => {
    setMenu(null);
    try {
      await fn();
    } catch (e) {
      alert((e as Error).message);
    }
    onChanged();
  };

  if (!songs.length) {
    return (
      <div className="page center">
        <div className="empty">
          <Icon name="library" size={40} />
          <h2>Your library is empty</h2>
          <p className="muted">Search for a song, it gets prepared once and is saved for next time.</p>
          <button className="btn primary" onClick={onSearch}>
            <Icon name="search" size={16} /> Search songs
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="toolbar">
        <div className="searchbar small">
          <Icon name="search" size={18} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${songs.length} songs`} />
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="recent">Recently added</option>
          <option value="title">Title</option>
          <option value="artist">Artist</option>
          <option value="played">Most sung</option>
        </select>
      </div>
      <div className="grid">
        {list.map((s) => (
          <div className={`card ${s.status}`} key={s.id}>
            <button className="card-art" onClick={() => s.status === "ready" && onPlay(s.id)} disabled={s.status !== "ready"}>
              <img src={s.cover} alt="" loading="lazy" />
              {s.status === "ready" ? (
                <span className="card-play"><Icon name="play" size={28} /></span>
              ) : (
                <span className="card-status">
                  <span>{statusLabel(s)}</span>
                  {s.status !== "error" && (
                    <span className="bar"><span style={{ width: `${Math.round(s.progress * 100)}%` }} /></span>
                  )}
                </span>
              )}
              <span className="badges">
                {s.status === "ready" && (s.stage === "align" || s.stage === "model") && <span className="badge" title="Timing the lyrics on the vocal track">{STAGE_LABEL[s.stage]} {Math.round(s.progress * 100)}%</span>}
                {s.status === "ready" && !s.lyrics_synced && <span className="badge warn" title="No synced lyrics">{s.lyrics_source ? "text" : "no lyrics"}</span>}
                {!!s.has_video && <span className="badge" title="Music video available"><Icon name="video" size={12} /></span>}
              </span>
            </button>
            <div className="card-body">
              <div className="card-text">
                <div className="card-title" title={s.title}>{s.title}</div>
                <div className="muted small" title={s.artist}>{s.artist} {s.duration ? `· ${fmtTime(s.duration)}` : ""}</div>
                {s.status === "error" && <div className="err small" title={s.error}>{s.error}</div>}
              </div>
              <button className="icon-btn small" onClick={() => setMenu(menu === s.id ? null : s.id)} aria-label="More">⋯</button>
              {menu === s.id && (
                <div className="menu" onMouseLeave={() => setMenu(null)}>
                  {s.status === "ready" && (
                    <button onClick={() => act(async () => {
                      const singer = await askSinger();
                      if (singer !== null) await api.enqueue(s.id, singer);
                    })}>
                      <Icon name="queue" size={16} /> Add to queue
                    </button>
                  )}
                  <button onClick={() => { setMenu(null); setEditing(s.id); }}>
                    <Icon name="edit" size={16} /> Lyrics
                  </button>
                  {s.status === "ready" && s.lyrics_source && (
                    <button onClick={() => act(() => api.alignLyrics(s.id))} disabled={!!s.stage}>
                      <Icon name="refresh" size={16} /> Time lyrics again
                    </button>
                  )}
                  {Object.entries(models).map(([m, label]) => (
                    <button key={m} onClick={() => act(() => api.reprocess(s.id, m))} title={label} disabled={s.status !== "ready" && s.status !== "error"}>
                      <Icon name="refresh" size={16} /> Separate with {m}{s.model === m ? " (current)" : ""}
                    </button>
                  ))}
                  {s.status === "error" && (
                    <button onClick={() => act(() => api.reprocess(s.id, undefined, true))}>
                      <Icon name="refresh" size={16} /> Download again
                    </button>
                  )}
                  <button className="danger" onClick={() => confirm(`Delete "${s.title}" and its files?`) && act(() => api.remove(s.id))}>
                    <Icon name="trash" size={16} /> Delete
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {editing && <LyricsEditor songId={editing} onClose={() => { setEditing(null); onChanged(); }} />}
    </div>
  );
}
