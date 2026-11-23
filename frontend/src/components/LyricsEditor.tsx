import { useEffect, useState } from "react";
import { api, type SongDetail } from "../api";
import { Icon } from "./Icon";

export function LyricsEditor({ songId, onClose }: { songId: string; onClose: () => void }) {
  const [song, setSong] = useState<SongDetail | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.song(songId).then((s) => {
      setSong(s);
      setText(s.lyrics_raw);
    });
  }, [songId]);

  const run = async (fn: () => Promise<SongDetail>, done: string) => {
    setBusy(true);
    setMsg("");
    try {
      const s = await fn();
      setSong(s);
      setText(s.lyrics_raw);
      setMsg(done);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>{song?.title ?? "Lyrics"}</h3>
            <div className="muted small">
              {song ? `${song.lyrics_synced ? "Synced" : "Not synced"} · source: ${song.lyrics_source || "none"}` : "Loading"}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder={"Paste LRC lyrics, e.g.\n[00:12.40]First line\n[00:15.90]Second line"}
        />
        <div className="muted small">
          Lines with [mm:ss.xx] timestamps are synced. Plain text scrolls along with the song. Manual lyrics are kept when the song is processed again.
        </div>
        <div className="row end">
          {msg && <span className="muted small grow">{msg}</span>}
          <button className="btn" disabled={busy} onClick={() => run(() => api.refetchLyrics(songId), "Searched again")}>
            <Icon name="refresh" size={16} /> Search again
          </button>
          <button className="btn primary" disabled={busy} onClick={() => run(() => api.setLyrics(songId, text), "Saved")}>
            <Icon name="check" size={16} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}
