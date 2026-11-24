"""Word timing from the Demucs vocal stem.

LRC files from LRCLIB only time whole lines, and often for a slightly different release
than the audio Encore downloaded. This module:

1. finds a global offset by matching line starts against where the vocal stem is voiced,
2. force-aligns every line's words on the vocal stem with torchaudio's MMS_FA model
   (CTC, multilingual, Latin script), inside a window around the line's LRC time,
3. drops lines whose result does not look right (they keep the LRC time plus the offset).

Plain (unsynced) lyrics are aligned over the whole song instead.

It runs as a subprocess (``python -m encore.align``) like Demucs, so the 1.2 GB model is
freed after each song and a job can be cancelled by killing the process. The result is
``timing.json`` in the song folder, keyed to a hash of the lyrics text: when the lyrics
change, the old timing is ignored.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from typing import Any

from . import config, lyrics

SR = 16000
VERSION = 1
FPS = 100  # voiced-activity frames per second
MAX_LINE_SHIFT = 1.5  # an aligned line may start at most this far from its (offset) LRC time
MIN_VOICED = 0.3  # share of a line's word time that must be voiced on the vocal stem
MIN_ACCEPTED = 0.4  # below this share of good lines the whole alignment is discarded
_BRACKETS = re.compile(r"\([^)]*\)|\[[^\]]*\]")  # backing vocals: shown, not aligned


def lyrics_hash(text: str) -> str:
    return hashlib.sha1(text.strip().encode()).hexdigest()[:16]


# ---- reading the result (used by the API, no torch needed) --------------------

def load_timing(folder: Path, text: str) -> dict[str, Any] | None:
    path = folder / "timing.json"
    if not text or not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if data.get("version") != VERSION or data.get("hash") != lyrics_hash(text):
        return None
    return data


def apply_timing(lines: list[dict[str, Any]], timing: dict[str, Any] | None) -> tuple[list[dict[str, Any]], bool]:
    """Merge timing.json into parsed lyrics. Returns (lines, synced)."""
    if not timing:
        return lines, bool(lines) and lines[0]["t"] is not None
    timed = timing.get("lines") or []
    off = float(timing.get("offset") or 0)
    out = []
    if timing.get("mode") == "plain":
        # Only lines that got timing are kept as synced lines; blank lines are dropped.
        for line, tl in zip(lines, timed):
            if tl:
                out.append({**line, "t": tl["t"], "end": tl["end"], "words": tl["words"]})
        if not out:
            return lines, False
        return out, True
    for line, tl in zip(lines, timed):
        if tl:
            out.append({**line, "t": tl["t"], "end": tl["end"], "words": tl["words"]})
        else:
            out.append({**line, "t": line["t"] + off, "end": line["end"] + off,
                        "words": [{**w, "t": w["t"] + off} for w in line["words"]]})
    out.sort(key=lambda line: line["t"])
    return out, True


# ---- audio helpers ------------------------------------------------------------

def _load(path: Path):
    import numpy as np

    raw = subprocess.run(
        ["ffmpeg", "-v", "quiet", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768


def _voiced(x):
    """FPS frames, True where the vocal stem is clearly louder than its quiet parts."""
    import numpy as np

    hop = SR // FPS
    n = len(x) // hop * hop
    env = np.sqrt((x[:n].reshape(-1, hop) ** 2).mean(1))
    d = 20 * np.log10(env + 1e-5)
    return d > np.percentile(d, 60)


def _voiced_share(act, spans) -> float:
    tot = v = 0
    for a, b in spans:
        ia, ib = int(a * FPS), min(len(act), int(b * FPS))
        if ib > ia:
            tot += ib - ia
            v += int(act[ia:ib].sum())
    return v / tot if tot else 0.0


def _global_offset(act, lines) -> float:
    import numpy as np

    def score(o: float) -> float:
        s = []
        for line in lines:
            a = int((line["t"] + o) * FPS)
            if a < 20 or a + 50 >= len(act):
                continue
            s.append(act[a:a + 50].mean() - act[a - 20:a].mean())  # quiet before, voiced after
        return float(np.mean(s)) if s else -1.0

    offs = np.arange(-6, 6.001, 0.05)
    sc = np.array([score(o) for o in offs])
    # Only move when it is clearly better than leaving the file alone.
    return round(float(offs[int(sc.argmax())]), 2) if sc.max() - score(0.0) > 0.08 else 0.0


def _tokens_for(text: str, dictionary: dict[str, int]) -> tuple[list[str], list[str | None]]:
    """Display words and, per word, its normalised form for the aligner (None: not aligned)."""
    display = text.split()
    sung = _BRACKETS.sub(lambda m: " " * len(m.group(0)), text)
    normed: list[str | None] = []
    pos = 0
    for w in display:
        start = text.index(w, pos)
        pos = start + len(w)
        part = sung[start:pos]
        n = unicodedata.normalize("NFKD", part.lower())
        n = "".join(c for c in n if c in dictionary and c not in "*-")
        normed.append(n or None)
    return display, normed


# ---- alignment ----------------------------------------------------------------

class Aligner:
    def __init__(self) -> None:
        import torch
        from torchaudio.pipelines import MMS_FA

        self.torch = torch
        self.model = MMS_FA.get_model().eval()  # downloads to $TORCH_HOME/hub once
        self.tokenizer = MMS_FA.get_tokenizer()
        self.align_fn = MMS_FA.get_aligner()
        self.dictionary = MMS_FA.get_dict()

    def emission(self, x):
        torch = self.torch
        with torch.inference_mode():
            em, _ = self.model(torch.from_numpy(x).unsqueeze(0))
        return em[0], len(x) / em.shape[1] / SR  # (frames, classes), seconds per frame

    def emission_long(self, x, chunk: float = 30.0):
        torch = self.torch
        step = int(chunk * SR)
        parts = []
        for a in range(0, len(x), step):
            seg = x[a:a + step]
            if len(seg) < SR // 10:
                break
            em, _ = self.emission(seg)
            parts.append(em)
        em = torch.cat(parts)
        return em, len(x) / em.shape[0] / SR

    def spans(self, em, words: list[str]):
        """Per word: (start_frame, end_frame, score). '*' absorbs audio outside the words."""
        tokens = self.tokenizer(["*"] + words + ["*"])
        out = self.align_fn(em, tokens)[1:-1]
        return [(sp[0].start, sp[-1].end, sum(t.score for t in sp) / len(sp)) for sp in out]


def _words_out(display: list[str], normed: list[str | None], times: list[tuple[float, float]]) -> list[dict[str, Any]]:
    """Give every display word a time; unaligned ones (backing vocals, symbols) sit in the gaps."""
    it = iter(times)
    known: list[tuple[float, float] | None] = [next(it) if n else None for n in normed]
    out = []
    for i, w in enumerate(display):
        t = known[i]
        if t is None:
            prev = next((known[j][1] for j in range(i - 1, -1, -1) if known[j]), None)
            nxt = next((known[j][0] for j in range(i + 1, len(known)) if known[j]), None)
            a = prev if prev is not None else nxt
            t = (a, a) if a is not None else (0.0, 0.0)
        text = w + (" " if i < len(display) - 1 else "")
        out.append({"t": round(t[0], 3), "end": round(t[1], 3), "text": text})
    return out


def align_synced(al: Aligner, x, act, lines, progress) -> dict[str, Any]:
    dur = len(x) / SR
    off = _global_offset(act, lines)
    result: list[dict[str, Any] | None] = []
    shifts = []
    for i, line in enumerate(lines):
        progress(i / max(1, len(lines)))
        start = line["t"] + off
        nxt = (lines[i + 1]["t"] + off) if i + 1 < len(lines) else start + 8
        a, b = max(0.0, start - 1.0), min(dur, max(nxt, start + 1.5) + 0.5)
        display, normed = _tokens_for(line["text"], al.dictionary)
        words = [n for n in normed if n]
        if not words or b - a < 0.5:
            result.append(None)
            continue
        em, spf = al.emission(x[int(a * SR):int(b * SR)])
        if em.shape[0] < sum(len(w) for w in words) + 2:
            result.append(None)
            continue
        try:
            times = [(a + s * spf, a + e * spf) for s, e, _ in al.spans(em, words)]
        except (RuntimeError, ValueError):  # audio window too short for the text
            result.append(None)
            continue
        first = times[0][0]
        if abs(first - start) > MAX_LINE_SHIFT or _voiced_share(act, times) < MIN_VOICED:
            result.append(None)
            continue
        shifts.append(first - line["t"])
        ws = _words_out(display, normed, times)
        result.append({"t": round(first, 3), "end": round(times[-1][1], 3), "words": ws})
    good = sum(r is not None for r in result)
    if lines and good / len(lines) < MIN_ACCEPTED:
        result = [None] * len(lines)  # probably the wrong lyrics or a different recording
    else:
        # Lines that were not aligned move with the typical shift of the aligned ones.
        shifts.sort()
        off = round(shifts[len(shifts) // 2], 2) if shifts else off
    return {"mode": "synced", "offset": off, "lines": result, "aligned": sum(r is not None for r in result)}


def align_plain(al: Aligner, x, act, lines, progress) -> dict[str, Any]:
    progress(0.05)
    em, spf = al.emission_long(x)
    progress(0.7)
    per_line = [_tokens_for(line["text"], al.dictionary) if line["text"].strip() else ([], []) for line in lines]
    words = [n for _, normed in per_line for n in normed if n]
    if not words or em.shape[0] < sum(len(w) for w in words) * 1.2:
        return {"mode": "plain", "offset": 0, "lines": [None] * len(lines), "aligned": 0}
    try:
        times = [(s * spf, e * spf) for s, e, _ in al.spans(em, words)]
    except (RuntimeError, ValueError):
        return {"mode": "plain", "offset": 0, "lines": [None] * len(lines), "aligned": 0}
    result: list[dict[str, Any] | None] = []
    k = 0
    for display, normed in per_line:
        n = sum(1 for w in normed if w)
        if not n:
            result.append(None)
            continue
        lt = times[k:k + n]
        k += n
        ws = _words_out(display, normed, lt)
        result.append({"t": round(lt[0][0], 3), "end": round(lt[-1][1], 3), "words": ws})
    spans = [(r["t"], r["end"]) for r in result if r]
    if _voiced_share(act, spans) < MIN_VOICED + 0.1:
        result = [None] * len(lines)
    return {"mode": "plain", "offset": 0, "lines": result, "aligned": sum(r is not None for r in result)}


def run(folder: Path, text: str, synced: bool) -> dict[str, Any]:
    def progress(f: float) -> None:
        print(f"PROGRESS {f:.3f}", flush=True)

    lines = lyrics.parse(text, synced)
    data: dict[str, Any] = {"version": VERSION, "hash": lyrics_hash(text), "mode": "synced" if synced else "plain",
                            "offset": 0, "lines": [None] * len(lines), "aligned": 0}
    if lines:
        vocals = config.stem_file(folder, "vocals")
        if vocals is None:
            raise FileNotFoundError("no vocal stem")
        x = _load(vocals)
        act = _voiced(x)
        al = Aligner()
        res = align_synced(al, x, act, lines, progress) if synced else align_plain(al, x, act, lines, progress)
        data.update(res)
    data["total"] = len(lines)
    tmp = folder / "timing.json.tmp"
    tmp.write_text(json.dumps(data))
    tmp.replace(folder / "timing.json")
    progress(1.0)
    return data


def main() -> None:
    folder, lyrics_file, synced = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3] == "1"
    import torch

    if len(sys.argv) > 4:
        torch.set_num_threads(int(sys.argv[4]))
    data = run(folder, lyrics_file.read_text(), synced)
    print(f"RESULT aligned={data['aligned']}/{data['total']} offset={data['offset']}", flush=True)


if __name__ == "__main__":
    main()
