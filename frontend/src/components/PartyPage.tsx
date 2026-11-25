import { useEffect, useState } from "react";
import { formatCode, joinUrl, type HostParty } from "../party";
import { Icon } from "./Icon";
import { QrCode } from "./QrCode";

interface Props {
  party: HostParty;
  online: boolean;
}

function ago(t: number): string {
  const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

export function PartyPage({ party, online }: Props) {
  const { info } = party;
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);

  // keeps "joined x min ago" and the lock countdown fresh
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30000);
    return () => window.clearInterval(id);
  }, []);

  const start = async () => {
    setBusy(true);
    try {
      if ((await party.start()) === "conflict") {
        if (confirm("A party is already running on another screen. End it and start a new one here? Its guests have to join again.")) {
          await party.start(true);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  if (!online) {
    return (
      <div className="page center">
        <div className="empty">
          <Icon name="cloudOff" size={40} />
          <h2>Party mode needs a connection</h2>
          <p className="muted">Guests connect through your Encore server.</p>
        </div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="page center">
        <div className="empty party-intro">
          <Icon name="users" size={40} />
          <h2>Sing together</h2>
          <p className="muted">
            Start a party on this screen. Friends join from their phones with a 6 digit code, add songs to the queue and
            control the music: play, pause, skip, volume, how much of the original voice they hear, and the background.
          </p>
          {party.error && <div className="alert">{party.error}</div>}
          <button className="btn primary big" onClick={start} disabled={busy}>
            <Icon name="users" /> Start a party
          </button>
        </div>
      </div>
    );
  }

  const url = joinUrl();
  const locked = info.join_locked_for > 0;

  return (
    <div className="page narrow">
      <div className="toolbar">
        <div>
          <h2>Party</h2>
          <div className="muted small">
            <span className={`dot ${party.connected ? "on" : ""}`} /> {party.connected ? "Guests can control this screen" : "Connecting…"}
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => party.newCode()} title="Earlier codes stop working, guests who joined stay">
            <Icon name="refresh" size={16} /> New code
          </button>
          <button className="btn ghost" onClick={() => confirm("End the party? All guests are disconnected.") && party.end()}>
            <Icon name="logout" size={16} /> End party
          </button>
        </div>
      </div>

      {party.error && <div className="alert">{party.error}</div>}
      {locked && (
        <div className="alert">
          Joining is paused for about {Math.ceil(info.join_locked_for / 60)} min: there were too many wrong codes. Guests who
          already joined are not affected.
        </div>
      )}

      <div className="party-join">
        <QrCode text={`${url}#${info.code}`} size={196} />
        <div className="party-join-text">
          <div className="muted">Scan the code, or open</div>
          <div className="party-url">{url.replace(/^https?:\/\//, "")}</div>
          <div className="muted">and enter</div>
          <div className="party-code">{formatCode(info.code)}</div>
        </div>
      </div>

      <h3 className="section-title">
        Guests <span className="muted">{info.guests.length || ""}</span>
      </h3>
      {info.guests.length === 0 ? (
        <p className="muted">Nobody has joined yet.</p>
      ) : (
        <div className="queue">
          {info.guests.map((g) => (
            <div className="qrow" key={g.id}>
              <span className={`dot ${g.online ? "on" : ""}`} title={g.online ? "Connected" : "Not connected right now"} />
              <div className="grow">
                <div className="qsinger">{g.name}</div>
                <div className="muted small">joined {ago(g.joined_at)}</div>
              </div>
              <button
                className="icon-btn small"
                onClick={() => confirm(`Remove ${g.name} from the party?`) && party.kick(g.id)}
                aria-label={`Remove ${g.name}`}
                title="Remove from the party"
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
