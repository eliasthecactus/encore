import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LyricLine } from "../api";

interface Props {
  lines: LyricLine[];
  synced: boolean;
  time: () => number; // current song time incl. lyrics offset
  duration: number;
  title: string;
  artist: string;
  singer?: string;
  scale: number;
}

const GAP = 4.5; // seconds without singing before the countdown dots appear

/** Fraction of the line that has been sung: from word timing (vocal stem or <mm:ss> tags) when there is any. */
function lineProgress(line: LyricLine, t: number): number {
  const start = line.t ?? 0;
  const end = line.end ?? start + 4;
  if (line.words.length) {
    const total = line.words.reduce((n, w) => n + w.text.length, 0) || 1;
    let done = 0;
    for (let i = 0; i < line.words.length; i++) {
      const w = line.words[i];
      // Aligned words carry their own end, so the fill rests in pauses instead of creeping on.
      const wEnd = Math.max(w.t + 0.08, w.end ?? line.words[i + 1]?.t ?? end);
      if (t < w.t) break;
      if (t >= wEnd) done += w.text.length;
      else {
        done += w.text.length * ((t - w.t) / Math.max(0.05, wEnd - w.t));
        break;
      }
    }
    return Math.min(1, done / total);
  }
  // Singers rarely stretch the very last syllable over the whole gap: finish at 90 % of the slot.
  const dur = Math.max(0.4, (end - start) * 0.9);
  return Math.min(1, Math.max(0, (t - start) / dur));
}

export function Lyrics({ lines, synced, time, duration, title, artist, singer, scale }: Props) {
  const timed = useMemo(() => lines.filter((l) => l.t !== null && l.text.trim() !== ""), [lines]);
  const [focus, setFocus] = useState(-1); // line the view is centred on
  const [active, setActive] = useState(-1); // line being sung right now
  const [gap, setGap] = useState(false);
  const [intro, setIntro] = useState(true);
  const column = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const lineEls = useRef<(HTMLDivElement | null)[]>([]);
  const fillEl = useRef<HTMLSpanElement | null>(null);
  const dots = useRef<HTMLDivElement>(null);

  // ---- synced lyrics loop ----
  useEffect(() => {
    if (!synced || !timed.length) return;
    let raf = 0;
    let prev = { focus: -2, active: -2, gap: false, intro: true };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = time();
      let i = -1;
      for (let k = 0; k < timed.length; k++) {
        if ((timed[k].t as number) <= t) i = k;
        else break;
      }
      const cur = i >= 0 ? timed[i] : null;
      const singing = !!cur && t < (cur.end as number);
      const next = timed[i + 1];
      const gapStart = cur ? (cur.end as number) : 0;
      const inGap = !singing && !!next && (next.t as number) - Math.max(gapStart, t) > 0 && (next.t as number) - gapStart > GAP;
      const f = singing ? i : next ? i + 1 : i;
      const a = singing ? i : -1;
      const showIntro = i < 0 && (timed[0].t as number) - t > 1.5;

      if (f !== prev.focus) setFocus(f);
      if (a !== prev.active) setActive(a);
      if (inGap !== prev.gap) setGap(inGap);
      if (showIntro !== prev.intro) setIntro(showIntro);
      prev = { focus: f, active: a, gap: inGap, intro: showIntro };

      if (singing && fillEl.current) fillEl.current.style.setProperty("--p", `${(lineProgress(cur!, t) * 100).toFixed(2)}%`);
      if (inGap && dots.current && next) {
        const left = (next.t as number) - t;
        dots.current.style.setProperty("--d", String(Math.max(0, Math.min(3, 3 - left))));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [synced, timed, time]);

  // ---- centre the focused line ----
  useLayoutEffect(() => {
    const col = column.current, vp = viewport.current;
    if (!col || !vp) return;
    const el = lineEls.current[Math.max(0, focus)];
    if (!el) return;
    const y = vp.clientHeight * 0.46 - (el.offsetTop + el.offsetHeight / 2);
    col.style.transform = `translate3d(0, ${y}px, 0)`;
  }, [focus, timed]);

  // ---- unsynced: slow auto-scroll ----
  useEffect(() => {
    if (synced || !lines.length) return;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const col = column.current, vp = viewport.current;
      if (!col || !vp || !duration) return;
      const f = Math.min(1, Math.max(0, (time() / duration - 0.06) / 0.88));
      const y = vp.clientHeight * 0.4 - f * Math.max(0, col.scrollHeight - vp.clientHeight * 0.2);
      col.style.transform = `translate3d(0, ${y}px, 0)`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [synced, lines, duration, time]);

  const style = { "--lyric-scale": scale } as React.CSSProperties;

  if (!lines.length) {
    return (
      <div className="lyrics" style={style}>
        <TitleCard title={title} artist={artist} singer={singer} note="No lyrics found for this song. You can paste them in the library." />
      </div>
    );
  }

  if (!synced) {
    return (
      <div className="lyrics unsynced" style={style} ref={viewport}>
        <div className="lyrics-col" ref={column}>
          <div className="unsynced-note">Lyrics without timing, scrolling along</div>
          {lines.map((l, i) => (
            <div key={i} className="line plain">{l.text || " "}</div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="lyrics" style={style} ref={viewport}>
      <div className={`lyrics-col ${intro ? "hidden" : ""}`} ref={column}>
        {timed.map((l, i) => {
          const d = i - focus;
          const cls = i === active ? "line active" : i < focus ? "line past" : d === 0 ? "line next" : "line";
          return (
            <div
              key={i}
              ref={(el) => {
                lineEls.current[i] = el;
              }}
              className={cls}
              style={{ opacity: Math.max(0, 1 - Math.abs(d) * (d < 0 ? 0.42 : 0.28)) }}
            >
              {i === active ? (
                <span className="fill" ref={fillEl} data-text={l.text}>
                  {l.text}
                </span>
              ) : (
                l.text
              )}
            </div>
          );
        })}
      </div>
      {gap && !intro && (
        <div className="gap-dots" ref={dots}>
          <i /><i /><i />
        </div>
      )}
      {intro && <TitleCard title={title} artist={artist} singer={singer} />}
    </div>
  );
}

function TitleCard({ title, artist, singer, note }: { title: string; artist: string; singer?: string; note?: string }) {
  return (
    <div className="titlecard">
      {singer && <div className="tc-singer">Up now: {singer}</div>}
      <div className="tc-title">{title}</div>
      <div className="tc-artist">{artist}</div>
      {note && <div className="tc-note">{note}</div>}
    </div>
  );
}
