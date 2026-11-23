import { api, fmtTime, statusLabel, type QueueEntry } from "../api";
import { Icon } from "./Icon";

interface Props {
  queue: QueueEntry[];
  online: boolean;
  onChanged: () => void;
  onStart: () => void;
  onSearch: () => void;
}

export function Queue({ queue, online, onChanged, onStart, onSearch }: Props) {
  const move = async (i: number, d: number) => {
    const ids = queue.map((q) => q.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.reorder(ids);
    onChanged();
  };

  const total = queue.reduce((n, q) => n + (q.duration || 0), 0);

  if (!online) {
    return (
      <div className="page center">
        <div className="empty">
          <Icon name="cloudOff" size={40} />
          <h2>The queue needs a connection</h2>
          <p className="muted">The party queue lives on your Encore server. Connect to the same network to see and add singers.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="toolbar">
        <div>
          <h2>Party queue</h2>
          <div className="muted small">
            {queue.length ? `${queue.length} songs · about ${Math.round(total / 60)} min` : "Nobody is lined up yet"}
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={onSearch}><Icon name="plus" size={16} /> Add song</button>
          {queue.length > 0 && (
            <>
              <button className="btn primary" onClick={onStart}><Icon name="play" size={16} /> Start</button>
              <button className="btn ghost" onClick={async () => { if (confirm("Clear the whole queue?")) { await api.clearQueue(); onChanged(); } }}>
                <Icon name="trash" size={16} />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="queue">
        {queue.map((q, i) => (
          <div className="qrow" key={q.id}>
            <div className="qnum">{i + 1}</div>
            <img src={q.cover} alt="" />
            <div className="grow">
              <div className="qsinger">{q.singer || "Anyone"}</div>
              <div className="muted small">
                {q.title} · {q.artist} {q.duration ? `· ${fmtTime(q.duration)}` : ""}
              </div>
              {q.status !== "ready" && <div className={`pill ${q.status}`}>{statusLabel(q)}</div>}
            </div>
            <button className="icon-btn small" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><Icon name="up" size={16} /></button>
            <button className="icon-btn small" onClick={() => move(i, 1)} disabled={i === queue.length - 1} aria-label="Move down"><Icon name="down" size={16} /></button>
            <button className="icon-btn small" onClick={async () => { await api.dequeue(q.id); onChanged(); }} aria-label="Remove"><Icon name="x" size={16} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
