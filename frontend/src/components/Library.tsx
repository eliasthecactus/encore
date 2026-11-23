import { useMemo, useState } from "react";
import { api, fmtTime, STAGE_LABEL, statusLabel, type Song } from "../api";
import { offlineCapable, removeSong, saveSong, useSaved, useSaving, type SavedSong } from "../offline";
import { Icon } from "./Icon";
import { LyricsEditor } from "./LyricsEditor";

interface Props {
  songs: Song[];
  online: boolean;
  models: Record<string, string>;
  onPlay: (id: string) => void;
  onChanged: () => void;
  askSinger: () => Promise<string | null>;
  onSearch: () => void;
}

type Sort = "recent" | "title" | "artist" | "played";

/** A saved song the cached library list does not know about (e.g. the list was never cached). */
function fromSaved(s: SavedSong): Song {
  return {
    id: s.id, title: s.title, artist: s.artist, album: "", duration: s.duration, thumbnail: "", cover: s.cover,
    status: "ready", stage: "", progress: 1, error: "", model: "", lyrics_synced: 1, lyrics_source: "",
    has_video: 0, has_cover: 1, play_count: 0, last_played_at: null, created_at: s.savedAt / 1000,
  };
}

export function Library({ songs, online, models, onPlay, onChanged, askSinger, onSearch }: Props) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const saved = useSaved();
  const saving = useSaving();

  const list = useMemo(() => {
    let pool = songs;
    if (!online) {
      // Offline only what is on this device can play.
      const known = new Set(songs.map((s) => s.id));
      pool = [...songs.filter((s) => saved[s.id]), ...Object.values(saved).filter((s) => !known.has(s.id)).map(fromSaved)];
    }
    const f = filter.trim().toLowerCase();
    const out = pool.filter((s) => !f || `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(f));
    const cmp: Record<Sort, (a: Song, b: Song) => number> = {
      recent: (a, b) => b.created_at - a.created_at,
      title: (a, b) => a.title.localeCompare(b.title),
      artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
      played: (a, b) => b.play_count - a.play_count,
    };
    return out.sort(cmp[sort]);
  }, [songs, filter, sort, online, saved]);

  const act = async (fn: () => Promise<unknown>) => {
    setMenu(null);
    try {
      await fn();
    } catch (e) {
      alert((e as Error).message);
    }
    onChanged();
  };

  if (!list.length && !filter) {
    return (
      <div className="page center">
        <div className="empty">
          <Icon name={online ? "library" : "cloudOff"} size={40} />
          {online ? (
            <>
              <h2>Your library is empty</h2>
              <p className="muted">Search for a song, it gets prepared once and is saved for next time.</p>
              <button className="btn primary" onClick={onSearch}>
                <Icon name="search" size={16} /> Search songs
              </button>
            </>
          ) : (
            <>
              <h2>No songs on this device</h2>
              <p className="muted">
                {offlineCapable
                  ? "While you are connected, open a song's menu and choose \"Save on this device\". Saved songs play without a connection."
                  : "Saving songs for offline use needs Encore over https."}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  const current = list.find((s) => s.id === menu);

  return (
    <div className="page">
      <div className="toolbar">
        <div className="searchbar small">
          <Icon name="search" size={18} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${list.length} song${list.length === 1 ? "" : "s"}`} />
        </div>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="recent">Recently added</option>
          <option value="title">Title</option>
          <option value="artist">Artist</option>
          <option value="played">Most sung</option>
        </select>
      </div>
      <div className="grid">
        {list.map((s) => {
          const progress = saving[s.id];
          return (
            <div className={`card ${s.status}`} key={s.id}>
              <button className="card-art" onClick={() => s.status === "ready" && onPlay(s.id)} disabled={s.status !== "ready"} aria-label={`Sing ${s.title}`}>
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
                  {progress !== undefined && <span className="badge" title="Saving on this device"><Icon name="download" size={12} /> {Math.round(progress * 100)}%</span>}
                  {saved[s.id] && progress === undefined && <span className="badge ok" title="Saved on this device, plays offline"><Icon name="device" size={12} /></span>}
                  {!!s.has_video && online && <span className="badge" title="Music video available"><Icon name="video" size={12} /></span>}
                </span>
              </button>
              <div className="card-body">
                <div className="card-text">
                  <div className="card-title" title={s.title}>{s.title}</div>
                  <div className="muted small" title={s.artist}>{s.artist} {s.duration ? `· ${fmtTime(s.duration)}` : ""}</div>
                  {s.status === "error" && <div className="err small" title={s.error}>{s.error}</div>}
                </div>
                <button className="icon-btn small" onClick={() => setMenu(menu === s.id ? null : s.id)} aria-label="More">⋯</button>
                {menu === s.id && current && (
                  <SongMenu
                    song={current}
                    online={online}
                    models={models}
                    isSaved={!!saved[s.id]}
                    isSaving={progress !== undefined}
                    onClose={() => setMenu(null)}
                    act={act}
                    askSinger={askSinger}
                    onLyrics={() => { setMenu(null); setEditing(s.id); }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {editing && <LyricsEditor songId={editing} onClose={() => { setEditing(null); onChanged(); }} />}
    </div>
  );
}

interface MenuProps {
  song: Song;
  online: boolean;
  models: Record<string, string>;
  isSaved: boolean;
  isSaving: boolean;
  onClose: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  askSinger: () => Promise<string | null>;
  onLyrics: () => void;
}

/** Dropdown on desktop, bottom sheet on phones (see styles.css). */
function SongMenu({ song: s, online, models, isSaved, isSaving, onClose, act, askSinger, onLyrics }: MenuProps) {
  const ready = s.status === "ready";
  return (
    <>
      <div className="menu-back" onClick={onClose} />
      <div className="menu" onMouseLeave={onClose} role="menu">
        <div className="menu-head">
          <img src={s.cover} alt="" />
          <div className="grow">
            <div className="card-title">{s.title}</div>
            <div className="muted small">{s.artist}</div>
          </div>
        </div>
        {ready && online && (
          <button onClick={() => act(async () => {
            const singer = await askSinger();
            if (singer !== null) await api.enqueue(s.id, singer);
          })}>
            <Icon name="queue" size={16} /> Add to queue
          </button>
        )}
        {ready && offlineCapable && (isSaved ? (
          <button onClick={() => act(() => removeSong(s.id))}>
            <Icon name="trash" size={16} /> Remove from this device
          </button>
        ) : (
          <button onClick={() => act(() => saveSong(s.id))} disabled={!online || isSaving}>
            <Icon name="download" size={16} /> {isSaving ? "Saving on this device…" : "Save on this device"}
          </button>
        ))}
        {online && (
          <>
            <button onClick={onLyrics}>
              <Icon name="edit" size={16} /> Lyrics
            </button>
            {ready && s.lyrics_source && (
              <button onClick={() => act(() => api.alignLyrics(s.id))} disabled={!!s.stage}>
                <Icon name="refresh" size={16} /> Time lyrics again
              </button>
            )}
            {Object.entries(models).map(([m, label]) => (
              <button key={m} onClick={() => act(() => api.reprocess(s.id, m))} title={label} disabled={!ready && s.status !== "error"}>
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
          </>
        )}
        <button className="menu-cancel" onClick={onClose}>Cancel</button>
      </div>
    </>
  );
}
