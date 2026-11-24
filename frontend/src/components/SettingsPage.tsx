import { useEffect, useRef, useState } from "react";
import { api, fmtBytes, type Background, type BackgroundMode, type ConfigResponse, type Settings, type SystemInfo } from "../api";
import { offlineCapable, removeAll, useInstall, useSaved } from "../offline";
import { Icon } from "./Icon";

interface Props {
  config: ConfigResponse;
  backgrounds: Background[];
  onSaved: (c: ConfigResponse) => void;
  onBackgrounds: () => void;
}

const BG_LABEL: Record<BackgroundMode, string> = {
  aurora: "Aurora (colours from the cover)",
  visualizer: "Audio visualizer",
  cover: "Cover art",
  video: "Music video",
  custom: "Your own image or video",
};

export function SettingsPage({ config, backgrounds, onSaved, onBackgrounds }: Props) {
  const s = config.settings;
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [saved, setSaved] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const [aligning, setAligning] = useState(false);
  const [alignMsg, setAlignMsg] = useState("");

  const alignAll = async () => {
    setAligning(true);
    try {
      const r = await api.alignAll();
      setAlignMsg(r.queued ? `${r.queued} song${r.queued === 1 ? "" : "s"} queued` : "All songs are already timed");
    } catch (e) {
      setAlignMsg((e as Error).message);
    } finally {
      setAligning(false);
    }
  };

  useEffect(() => {
    api.system().then(setSys).catch(() => {});
  }, []);

  const save = async (patch: Partial<Settings>) => {
    let c: ConfigResponse;
    try {
      c = await api.saveConfig(patch);
    } catch (e) {
      alert((e as Error).message);
      return;
    }
    onSaved(c);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1200);
  };

  const upload = async (f: File | undefined) => {
    if (!f) return;
    const r = await api.uploadBackground(f);
    onBackgrounds();
    await save({ custom_background: r.name, default_background: "custom" });
  };

  return (
    <div className="page narrow">
      <div className="toolbar">
        <h2>Settings</h2>
        {saved && <span className="pill ready">Saved</span>}
      </div>

      <DevicePanel />

      <section className="panel">
        <h3>Singing</h3>
        <label className="field">
          <span>Vocal level when a song starts <b>{Math.round(s.default_vocals * 100)}%</b></span>
          <input type="range" min={0} max={1} step={0.05} defaultValue={s.default_vocals}
            onPointerUp={(e) => save({ default_vocals: Number((e.target as HTMLInputElement).value) })}
            onKeyUp={(e) => save({ default_vocals: Number((e.target as HTMLInputElement).value) })} />
        </label>
        <label className="field">
          <span>Default background</span>
          <select value={s.default_background} onChange={(e) => save({ default_background: e.target.value as BackgroundMode })}>
            {config.backgrounds.map((b) => <option key={b} value={b}>{BG_LABEL[b]}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Lyrics size <b>{Math.round(s.lyrics_font_scale * 100)}%</b></span>
          <input type="range" min={0.6} max={1.6} step={0.05} defaultValue={s.lyrics_font_scale}
            onPointerUp={(e) => save({ lyrics_font_scale: Number((e.target as HTMLInputElement).value) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={s.auto_advance} onChange={(e) => save({ auto_advance: e.target.checked })} />
          <span>Play the next song in the queue automatically</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.preload_next} onChange={(e) => save({ preload_next: e.target.checked })} />
          <span>Load the next song in the queue while the current one plays, so it starts right away</span>
        </label>
        <label className="field inline">
          <span>Countdown before the next song</span>
          <input type="number" min={0} max={30} value={s.countdown_seconds} onChange={(e) => save({ countdown_seconds: Number(e.target.value) })} />
          <span className="muted">seconds</span>
        </label>
      </section>

      <section className="panel">
        <h3>Your backgrounds</h3>
        <p className="muted small">Images or looping videos, saved in the config folder (backgrounds/).</p>
        <div className="bglist">
          {backgrounds.map((b) => (
            <div key={b.name} className={`bgthumb ${s.custom_background === b.name ? "on" : ""}`}>
              <button onClick={() => save({ custom_background: b.name })} title={b.name}>
                {b.kind === "video" ? <video src={b.url} muted /> : <img src={b.url} alt="" />}
              </button>
              <button className="icon-btn small del" onClick={async () => { await api.deleteBackground(b.name); onBackgrounds(); }} aria-label="Delete">
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
          <button className="bgthumb add" onClick={() => file.current?.click()}>
            <Icon name="upload" />
            <span className="small">Upload</span>
          </button>
          <input ref={file} type="file" accept="image/*,video/mp4,video/webm,video/quicktime" hidden onChange={(e) => upload(e.target.files?.[0])} />
        </div>
      </section>

      <section className="panel">
        <h3>Processing</h3>
        <label className="field">
          <span>Vocal separation model</span>
          <select value={s.model} onChange={(e) => save({ model: e.target.value })}>
            {Object.entries(config.models).map(([k, v]) => <option key={k} value={k}>{k}: {v}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Device</span>
          <select value={s.device} onChange={(e) => save({ device: e.target.value })}>
            <option value="auto">Auto (GPU if available)</option>
            <option value="cpu">CPU</option>
            <option value="cuda">NVIDIA GPU (CUDA)</option>
          </select>
        </label>
        <label className="field">
          <span>Stem format</span>
          <select value={s.stem_format} onChange={(e) => save({ stem_format: e.target.value as Settings["stem_format"] })}>
            <option value="aac">AAC (smaller, same quality)</option>
            <option value="mp3">MP3</option>
          </select>
        </label>
        <label className="field">
          <span>Stem quality</span>
          <select value={s.stem_bitrate} onChange={(e) => save({ stem_bitrate: Number(e.target.value) })}>
            {[96, 128, 160, 192, 256, 320].map((b) => (
              <option key={b} value={b}>{b} kbps{b === 160 ? " (recommended)" : ""}</option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.mono_vocals} onChange={(e) => save({ mono_vocals: e.target.checked })} />
          <span>Mono vocal stem (half the size and phone memory, vocals sit in the middle anyway)</span>
        </label>
        <p className="muted small">Format, quality and mono apply to songs processed from now on. Processing a song again applies them to it.</p>
        <label className="check">
          <input type="checkbox" checked={s.download_video} onChange={(e) => save({ download_video: e.target.checked })} />
          <span>Also download the music video as a background</span>
        </label>
        <label className="field">
          <span>Music video resolution</span>
          <select value={s.video_max_height} onChange={(e) => save({ video_max_height: Number(e.target.value) })}>
            {[360, 480, 720, 1080].map((h) => <option key={h} value={h}>{h}p</option>)}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.align_lyrics} onChange={(e) => save({ align_lyrics: e.target.checked })} />
          <span>Time every word on the vocal track (about a minute per song on a CPU, 1.2 GB model download once)</span>
        </label>
        <div className="row">
          <button className="btn" disabled={!s.align_lyrics || aligning} onClick={alignAll}>
            <Icon name="refresh" size={16} /> Time lyrics of existing songs
          </button>
          {alignMsg && <span className="muted small">{alignMsg}</span>}
        </div>
        <label className="field">
          <span>Lyrics sources (in order)</span>
          <select value={s.lyrics_sources.join(",")} onChange={(e) => save({ lyrics_sources: e.target.value.split(",") })}>
            <option value="lrclib,ytmusic">LRCLIB, then YouTube Music</option>
            <option value="ytmusic,lrclib">YouTube Music, then LRCLIB</option>
            <option value="lrclib">LRCLIB only</option>
            <option value="ytmusic">YouTube Music only</option>
          </select>
        </label>
      </section>

      {sys && (
        <section className="panel">
          <h3>System</h3>
          <dl className="kv">
            <dt>Encore</dt><dd>{sys.version}</dd>
            <dt>yt-dlp</dt><dd>{sys.yt_dlp}</dd>
            <dt>Separation runs on</dt><dd>{sys.device.toUpperCase()}</dd>
            <dt>Library size</dt><dd>{fmtBytes(sys.library_bytes)}</dd>
            <dt>Free disk</dt><dd>{fmtBytes(sys.disk_free_bytes)}</dd>
            <dt>YouTube cookies</dt><dd>{sys.cookies ? "cookies.txt found" : "none (add cookies.txt to the config folder if downloads get blocked)"}</dd>
          </dl>
        </section>
      )}

      <section className="panel">
        <h3>Keyboard on the stage</h3>
        <dl className="kv keys">
          <dt>Space</dt><dd>Play / pause</dd>
          <dt>← →</dt><dd>Seek 5 seconds</dd>
          <dt>↑ ↓</dt><dd>Vocals ±10%</dd>
          <dt>[ ]</dt><dd>Lyrics earlier / later</dd>
          <dt>B</dt><dd>Next background</dd>
          <dt>N</dt><dd>Next song in queue</dd>
          <dt>F</dt><dd>Fullscreen</dd>
        </dl>
      </section>
    </div>
  );
}

/** Install as an app and songs saved on this device. Everything here is per device. */
function DevicePanel() {
  const { canPrompt, installed, ios, install } = useInstall();
  const saved = useSaved();
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null);
  const list = Object.values(saved);
  const bytes = list.reduce((n, s) => n + s.bytes, 0);

  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => setQuota({ usage: e.usage ?? 0, quota: e.quota ?? 0 })).catch(() => {});
  }, [list.length]);

  return (
    <section className="panel">
      <h3>This device</h3>
      <div className="row between">
        <div className="grow">
          <div>Encore as an app</div>
          <div className="muted small">
            {installed
              ? "Installed. It opens in its own window and starts without the browser."
              : canPrompt
                ? "Adds Encore to your home screen or start menu, with its own window."
                : !offlineCapable
                  ? "Installing and offline use need Encore over https (or localhost). See \"Install as an app\" in the README."
                  : ios
                    ? "In Safari: tap Share, then \"Add to Home Screen\"."
                    : "Use the browser menu. In Edge: ⋯ > Apps > Install this site as an app."}
          </div>
        </div>
        {canPrompt && !installed && (
          <button className="btn primary" onClick={() => void install()}><Icon name="install" size={16} /> Install</button>
        )}
      </div>
      {offlineCapable && (
        <div className="row between">
          <div className="grow">
            <div>Songs saved on this device</div>
            <div className="muted small">
              {list.length
                ? `${list.length} song${list.length === 1 ? "" : "s"}, ${fmtBytes(bytes)}. They play without a connection.`
                : "None yet. Use \"Save on this device\" in a song's menu in the library."}
              {quota && quota.quota > 0 ? ` Browser storage: ${fmtBytes(quota.usage)} of ${fmtBytes(quota.quota)} used.` : ""}
            </div>
          </div>
          {list.length > 0 && (
            <button className="btn" onClick={() => confirm("Remove all songs saved on this device?") && void removeAll()}>
              <Icon name="trash" size={16} /> Remove all
            </button>
          )}
        </div>
      )}
    </section>
  );
}
