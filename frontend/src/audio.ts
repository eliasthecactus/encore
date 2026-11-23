/**
 * Plays the instrumental and vocal stems sample-locked on one AudioContext.
 * The vocal slider is just the gain of the vocal stem.
 */

let sharedCtx: AudioContext | null = null;

export function audioContext(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext({ latencyHint: "playback" });
  return sharedCtx;
}

async function fetchBuffer(ctx: AudioContext, url: string, onProgress: (f: number) => void): Promise<AudioBuffer> {
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
  playing = false;
  onEnded: (() => void) | null = null;

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

  async play(): Promise<void> {
    if (this.playing || !this.inst || !this.voc) return;
    if (this.ctx.state !== "running") await this.ctx.resume();
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
  }

  pause(): void {
    if (!this.playing) return;
    this.offset = this.offset + (this.ctx.currentTime - this.startedAt);
    this.stopSources();
    this.playing = false;
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
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
    this.stopSources();
    this.playing = false;
    this.master.disconnect();
    this.analyser.disconnect();
    this.inst = this.voc = null;
  }
}
