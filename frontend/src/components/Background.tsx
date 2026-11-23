import { useEffect, useRef } from "react";
import type { BackgroundMode } from "../api";
import type { StemPlayer } from "../audio";
import { rgb, type RGB } from "../palette";

interface Props {
  mode: BackgroundMode;
  cover: string;
  video: string | null | undefined;
  custom: { url: string; kind: "image" | "video" } | null;
  player: StemPlayer | null;
  palette: RGB[];
}

/** Bass energy 0..1 from the analyser, used to make backgrounds breathe. */
function bassLevel(an: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  an.getByteFrequencyData(buf);
  let sum = 0;
  const n = 12;
  for (let i = 1; i <= n; i++) sum += buf[i];
  return sum / (n * 255);
}

export function Background({ mode, cover, video, custom, player, palette }: Props) {
  const effective: BackgroundMode =
    mode === "video" && !video ? "cover" : mode === "custom" && !custom ? "aurora" : mode;

  return (
    <div className="bg">
      {effective === "aurora" && <Aurora palette={palette} player={player} />}
      {effective === "visualizer" && <Visualizer palette={palette} player={player} />}
      {effective === "cover" && <CoverBg cover={cover} player={player} />}
      {effective === "video" && video && <SyncedVideo src={video} player={player} />}
      {effective === "custom" && custom && (
        custom.kind === "video" ? (
          <video className="bg-media" src={custom.url} autoPlay muted loop playsInline />
        ) : (
          <img className="bg-media kenburns" src={custom.url} alt="" />
        )
      )}
      <div className={`bg-shade ${effective === "video" || effective === "custom" ? "strong" : ""}`} />
    </div>
  );
}

function usePulse(player: StemPlayer | null, el: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!player) return;
    const buf = new Uint8Array(player.analyser.frequencyBinCount);
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      const v = player.playing ? bassLevel(player.analyser, buf) : 0;
      smooth += (v - smooth) * 0.25;
      el.current?.style.setProperty("--pulse", smooth.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player, el]);
}

function Aurora({ palette, player }: { palette: RGB[]; player: StemPlayer | null }) {
  const ref = useRef<HTMLDivElement>(null);
  usePulse(player, ref);
  return (
    <div className="aurora" ref={ref}>
      {palette.slice(0, 4).map((c, i) => (
        <span key={i} className={`blob b${i}`} style={{ background: `radial-gradient(circle at center, ${rgb(c, 0.85)}, ${rgb(c, 0)} 65%)` }} />
      ))}
      <div className="grain" />
    </div>
  );
}

function CoverBg({ cover, player }: { cover: string; player: StemPlayer | null }) {
  const ref = useRef<HTMLDivElement>(null);
  usePulse(player, ref);
  return (
    <div className="coverbg" ref={ref}>
      {cover && <img src={cover} alt="" className="coverbg-blur" />}
      {cover && <img src={cover} alt="" className="coverbg-art" />}
    </div>
  );
}

function SyncedVideo({ src, player }: { src: string; player: StemPlayer | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || !player) return;
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 200) return;
      last = now;
      const t = player.currentTime;
      if (!v.duration || t >= v.duration) {
        if (!v.paused) v.pause();
        return;
      }
      if (player.playing && v.paused) void v.play().catch(() => {});
      if (!player.playing && !v.paused) v.pause();
      const drift = v.currentTime - t;
      if (Math.abs(drift) > 0.35) v.currentTime = t;
      else v.playbackRate = player.playing ? 1 - drift * 0.5 : 1; // ease small drift away
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [player, src]);
  return <video ref={ref} className="bg-media" src={src} muted playsInline preload="auto" />;
}

function Visualizer({ palette, player }: { palette: RGB[]; player: StemPlayer | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const g = cv.getContext("2d")!;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const resize = () => {
      cv.width = cv.clientWidth * dpr;
      cv.height = cv.clientHeight * dpr;
    };
    resize();
    window.addEventListener("resize", resize);
    const an = player?.analyser;
    const freq = new Uint8Array(an ? an.frequencyBinCount : 1024);
    const BARS = 96;
    const levels = new Float32Array(BARS);
    let raf = 0;
    let rot = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const W = cv.width, H = cv.height;
      if (an && player?.playing) an.getByteFrequencyData(freq);
      else freq.fill(0);
      // log-spaced bins so the bass doesn't take every bar
      for (let i = 0; i < BARS; i++) {
        const lo = Math.floor(Math.pow(freq.length * 0.7, i / BARS));
        const hi = Math.max(lo + 1, Math.floor(Math.pow(freq.length * 0.7, (i + 1) / BARS)));
        let m = 0;
        for (let k = lo; k < hi; k++) m = Math.max(m, freq[k]);
        const v = m / 255;
        levels[i] += (v - levels[i]) * (v > levels[i] ? 0.5 : 0.12);
      }
      const bass = (levels[0] + levels[1] + levels[2] + levels[3]) / 4;
      g.fillStyle = "rgba(6,5,10,0.28)";
      g.fillRect(0, 0, W, H);

      const cx = W / 2, cy = H / 2;
      const R = Math.min(W, H) * (0.2 + bass * 0.05);
      rot += 0.0015 + bass * 0.01;
      const glow = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 2.6);
      glow.addColorStop(0, rgb(palette[0], 0.18 + bass * 0.3));
      glow.addColorStop(1, rgb(palette[1], 0));
      g.fillStyle = glow;
      g.fillRect(0, 0, W, H);

      g.lineCap = "round";
      g.lineWidth = Math.max(2, (Math.PI * 2 * R) / BARS / 2.2);
      for (let side = 0; side < 2; side++) {
        for (let i = 0; i < BARS; i++) {
          const a = rot + (side ? -1 : 1) * (i / BARS) * Math.PI + Math.PI / 2;
          const len = 6 * dpr + levels[i] * Math.min(W, H) * 0.32;
          const c = palette[i % 3 === 0 ? 2 : side];
          g.strokeStyle = rgb(c, 0.55 + levels[i] * 0.45);
          g.beginPath();
          g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
          g.lineTo(cx + Math.cos(a) * (R + len), cy + Math.sin(a) * (R + len));
          g.stroke();
        }
      }
      // mirrored spectrum along the floor
      const bw = W / BARS;
      for (let i = 0; i < BARS; i++) {
        const h = levels[i] * H * 0.22;
        const grad = g.createLinearGradient(0, H, 0, H - h);
        grad.addColorStop(0, rgb(palette[3], 0.5));
        grad.addColorStop(1, rgb(palette[0], 0));
        g.fillStyle = grad;
        g.fillRect(i * bw + 1, H - h, bw - 2, h);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [player, palette]);
  return <canvas ref={canvas} className="bg-media viz" />;
}
