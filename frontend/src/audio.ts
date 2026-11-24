/**
 * Plays the instrumental and vocal stems sample-locked on one AudioContext.
 * The vocal slider is just the gain of the vocal stem.
 */

let sharedCtx: AudioContext | null = null;

/**
 * iOS treats Web Audio as "ambient" by default, so the silent switch mutes it.
 * Declaring the page as media playback (Safari 16.4+) makes it play like a music app.
 */
function preferPlaybackSession(): void {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (!session || session.type === "playback") return;
  try {
    session.type = "playback";
  } catch {
    /* not supported */
  }
}

export function audioContext(): AudioContext {
  preferPlaybackSession();
  if (!sharedCtx) sharedCtx = new AudioContext({ latencyHint: "playback" });
  return sharedCtx;
}

/**
 * Resolves true once the context runs. Outside a tap iOS leaves resume() pending
 * forever, so give up after a moment and let the caller ask for a tap instead.
 */
async function resumeSoon(ctx: AudioContext, ms = 400): Promise<boolean> {
  if (ctx.state === "running") return true;
  preferPlaybackSession();
  const resumed = ctx.resume().then(
    () => true,
    () => false,
  );
  const timeout = new Promise<boolean>((r) => window.setTimeout(() => r(false), ms));
  return (await Promise.race([resumed, timeout])) && (ctx.state as AudioContextState) === "running";
}

// ---- prefetch: the next song's encoded stems, kept as bytes (decoding waits for its turn) ----

const prefetched = new Map<string, Promise<ArrayBuffer | null>>();

export function prefetchStems(urls: string[]): void {
  for (const url of [...prefetched.keys()]) if (!urls.includes(url)) prefetched.delete(url);
  for (const url of urls) {
    if (prefetched.has(url)) continue;
    prefetched.set(
      url,
      fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null),
    );
  }
}

async function takePrefetched(url: string): Promise<ArrayBuffer | null> {
  const p = prefetched.get(url);
  if (!p) return null;
  prefetched.delete(url);
  return p;
}

async function fetchBuffer(ctx: AudioContext, url: string, onProgress: (f: number) => void): Promise<AudioBuffer> {
  const ready = await takePrefetched(url);
  if (ready) {
    onProgress(1);
    return ctx.decodeAudioData(ready);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let data: ArrayBuffer;
  if (res.body && total) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(got / total);
    }
    const all = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) {
      all.set(c, o);
      o += c.length;
    }
    data = all.buffer;
  } else {
    data = await res.arrayBuffer();
  }
  onProgress(1);
  return ctx.decodeAudioData(data);
}

export class StemPlayer {
  readonly ctx = audioContext();
  readonly analyser: AnalyserNode;
  private master: GainNode;
  private instGain: GainNode;
  private vocGain: GainNode;
  private inst: AudioBuffer | null = null;
  private voc: AudioBuffer | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private startedAt = 0; // ctx time when playback (re)started
  private offset = 0; // song position at startedAt
  private generation = 0;
  private intent = 0; // bumps on every play/pause so a late resume() cannot restart a paused song
  playing = false;
  onEnded: (() => void) | null = null;
  /** True while the song should be playing but iOS holds the audio (needs a tap). */
  onBlocked: ((blocked: boolean) => void) | null = null;
  private onState = () => this.onBlocked?.(this.playing && this.ctx.state !== "running");

  constructor() {
    this.master = this.ctx.createGain();
    this.instGain = this.ctx.createGain();
    this.vocGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.82;
    this.instGain.connect(this.master);
    this.vocGain.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.ctx.addEventListener("statechange", this.onState);
  }

  async load(instUrl: string, vocUrl: string, onProgress: (f: number) => void): Promise<void> {
    const p = [0, 0];
    const report = () => onProgress((p[0] + p[1]) / 2);
    const [inst, voc] = await Promise.all([
      fetchBuffer(this.ctx, instUrl, (f) => ((p[0] = f), report())),
      fetchBuffer(this.ctx, vocUrl, (f) => ((p[1] = f), report())),
    ]);
    this.inst = inst;
    this.voc = voc;
  }

  get duration(): number {
    return this.inst?.duration ?? 0;
  }

  /** Song position that is audible right now (output latency compensated). */
  get currentTime(): number {
    if (!this.playing) return this.offset;
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    const t = this.offset + (this.ctx.currentTime - this.startedAt) - latency;
    return Math.max(0, Math.min(t, this.duration));
  }

  /**
   * Starts (or, after an interruption, resumes) playback. Call it straight from a tap
   * where possible. Resolves false when the browser wants a tap first.
   */
  async play(): Promise<boolean> {
    if (!this.inst || !this.voc) return false;
    const intent = ++this.intent;
    if (!(await resumeSoon(this.ctx))) return false;
    if (intent !== this.intent) return false; // paused or restarted meanwhile
    this.onState();
    if (this.playing) return true;
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    const gen = ++this.generation;
    const when = this.ctx.currentTime + 0.05;
    this.sources = [
      [this.inst, this.instGain],
      [this.voc, this.vocGain],
    ].map(([buf, gain]) => {
      const s = this.ctx.createBufferSource();
      s.buffer = buf as AudioBuffer;
      s.connect(gain as GainNode);
      s.start(when, this.offset);
      return s;
    });
    this.sources[0].onended = () => {
      if (gen !== this.generation) return; // stopped on purpose
      this.playing = false;
      this.offset = this.duration;
      this.onEnded?.();
    };
    this.startedAt = when;
    this.playing = true;
    return true;
  }

  pause(): void {
    this.intent++;
    if (!this.playing) return;
    this.offset = this.offset + (this.ctx.currentTime - this.startedAt);
    this.stopSources();
    this.playing = false;
    this.onState();
  }

  seek(t: number): void {
    const was = this.playing;
    if (was) {
      this.stopSources();
      this.playing = false;
    }
    this.offset = Math.max(0, Math.min(t, this.duration - 0.01));
    if (was) void this.play();
  }

  setVocals(v: number): void {
    this.vocGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  setVolume(v: number): void {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  private stopSources(): void {
    this.generation++;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
    this.sources = [];
  }

  destroy(): void {
    this.intent++;
    this.ctx.removeEventListener("statechange", this.onState);
    this.onBlocked = null;
    this.stopSources();
    this.playing = false;
    this.master.disconnect();
    this.analyser.disconnect();
    this.inst = this.voc = null;
  }
}
