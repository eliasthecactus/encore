"""Background job runner: download -> separate vocals -> lyrics -> word timing -> music video."""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import threading
from collections import deque
from pathlib import Path
from typing import Any

import requests
import yt_dlp

from . import config, db, lyrics, ytm

log = logging.getLogger("encore.worker")

# Overall progress budget per stage (sums to 1).
STAGES = {"download": (0.0, 0.15), "separate": (0.15, 0.85), "lyrics": (0.85, 0.87), "align": (0.87, 0.95),
          "video": (0.95, 1.0)}


class Cancelled(Exception):
    pass


def song_dir(song_id: str) -> Path:
    return config.LIBRARY_DIR / song_id


def find_source(folder: Path) -> Path | None:
    for p in sorted(folder.glob("source.*")):
        if p.suffix not in (".part", ".ytdl", ".tmp"):
            return p
    return None


def _ydl_base() -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "retries": 5,
        "fragment_retries": 5,
        "concurrent_fragment_downloads": 4,
    }
    if config.COOKIES_PATH.exists():
        opts["cookiefile"] = str(config.COOKIES_PATH)
    return opts


_device_cache: str | None = None


def resolve_device(setting: str) -> str:
    global _device_cache
    if setting != "auto":
        return setting
    if _device_cache is None:
        try:
            import torch

            _device_cache = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            _device_cache = "cpu"
    return _device_cache


class Worker:
    def __init__(self) -> None:
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._current: str | None = None
        self._cancel: set[str] = set()
        self._proc: subprocess.Popen | None = None
        self._threads: list[threading.Thread] = []
        self._align_queue: deque[str] = deque()  # ready songs that only need new word timing

    # -- control --------------------------------------------------------------
    def start(self) -> None:
        t = threading.Thread(target=self._loop, name="encore-worker", daemon=True)
        t.start()
        self._threads.append(t)

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        self.cancel(self._current or "")

    def poke(self) -> None:
        self._wake.set()

    def queue_align(self, song_id: str) -> None:
        """Re-time the lyrics of a ready song without touching its audio or status."""
        with self._lock:
            if song_id not in self._align_queue:
                self._align_queue.append(song_id)
        self._wake.set()

    def cancel(self, song_id: str) -> None:
        with self._lock:
            if song_id and song_id == self._current:
                self._cancel.add(song_id)
                if self._proc and self._proc.poll() is None:
                    self._proc.kill()

    @property
    def current(self) -> str | None:
        return self._current

    # -- loop -----------------------------------------------------------------
    def _loop(self) -> None:
        while not self._stop.is_set():
            align_only = False
            with self._lock:
                song_id = self._align_queue.popleft() if self._align_queue else None
            song = db.get_song(song_id) if song_id else None
            if song and song["status"] == "ready":
                align_only = True
            else:
                song = db.next_queued_song()
            if not song:
                self._wake.wait(timeout=5)
                self._wake.clear()
                continue
            with self._lock:
                self._current = song["id"]
                self._cancel.discard(song["id"])
            try:
                if align_only:
                    self._align_job(song)
                else:
                    self._process(song)
            except Cancelled:
                log.info("cancelled %s", song["id"])
            except Exception as exc:  # noqa: BLE001 - surface anything to the UI
                log.exception("job %s failed", song["id"])
                if db.get_song(song["id"]):
                    db.update_song(song["id"], status="error", stage="", error=_short_error(exc))
            finally:
                with self._lock:
                    self._current = None
                    self._proc = None

    def _check(self, song_id: str) -> None:
        if song_id in self._cancel or self._stop.is_set():
            raise Cancelled()

    def _progress(self, song_id: str, stage: str, frac: float, status: str | None = None) -> None:
        lo, hi = STAGES[stage]
        fields: dict[str, Any] = {"stage": stage, "progress": round(lo + (hi - lo) * max(0.0, min(1.0, frac)), 4)}
        if status:
            fields["status"] = status
        db.update_song(song_id, **fields)

    # -- pipeline -------------------------------------------------------------
    def _process(self, song: dict[str, Any]) -> None:
        sid = song["id"]
        settings = config.get()
        folder = song_dir(sid)
        folder.mkdir(parents=True, exist_ok=True)
        db.update_song(sid, error="")

        source = find_source(folder)
        if not source:
            source = self._download_audio(song, folder)
        self._check(sid)

        if not (folder / "cover.jpg").exists():
            self._download_cover(song, folder)

        stems_ok = all(config.stem_file(folder, n) for n in config.STEM_NAMES)
        if not stems_ok or song.get("model") != settings["model"]:
            self._separate(sid, source, folder, settings)
        self._check(sid)

        # Lyrics: keep manual edits, otherwise look them up (again).
        song = db.get_song(sid) or song
        if song.get("lyrics_source") != "manual":
            self._progress(sid, "lyrics", 0, status="finishing")
            text, synced, src = lyrics.fetch(song)
            db.update_song(sid, lyrics=text, lyrics_synced=int(synced), lyrics_source=src)
        self._check(sid)

        song = db.get_song(sid) or song
        if settings.get("align_lyrics", True) and song.get("lyrics"):
            self._progress(sid, "align", 0, status="finishing")
            try:
                self._align(song, folder)
            except Cancelled:
                raise
            except Exception:
                log.warning("word timing for %s failed", sid, exc_info=True)
        self._check(sid)

        if settings["download_video"] and not (folder / "video.mp4").exists():
            self._progress(sid, "video", 0, status="finishing")
            try:
                self._download_video(song, folder, settings)
            except Cancelled:
                raise
            except Exception:
                log.warning("music video for %s failed", sid, exc_info=True)

        db.update_song(sid, status="ready", stage="", progress=1.0,
                       has_video=int((folder / "video.mp4").exists()),
                       has_cover=int((folder / "cover.jpg").exists()))
        shutil.rmtree(folder / ".work", ignore_errors=True)

    def _align_job(self, song: dict[str, Any]) -> None:
        sid = song["id"]
        folder = song_dir(sid)
        if not song.get("lyrics") or not config.stem_file(folder, "vocals"):
            return
        db.update_song(sid, stage="align", progress=0.0)
        try:
            self._align(song, folder, standalone=True)
        except Cancelled:
            raise
        except Exception:
            log.warning("word timing for %s failed", sid, exc_info=True)
        finally:
            if db.get_song(sid):
                db.update_song(sid, stage="", progress=1.0)
            shutil.rmtree(folder / ".work" / "align", ignore_errors=True)

    def _align(self, song: dict[str, Any], folder: Path, standalone: bool = False) -> None:
        """Word timing from the vocal stem in a subprocess (see align.py)."""
        sid = song["id"]
        work = folder / ".work" / "align"
        work.mkdir(parents=True, exist_ok=True)
        (work / "lyrics.txt").write_text(song["lyrics"])
        cmd = [sys.executable, "-m", "encore.align", str(folder), str(work / "lyrics.txt"),
               "1" if song.get("lyrics_synced") else "0"]
        env = {**os.environ, "TORCH_HOME": str(config.MODELS_DIR), "PYTHONUNBUFFERED": "1",
               "PYTHONPATH": str(Path(__file__).resolve().parent.parent)}
        with self._lock:
            self._check(sid)
            self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
        proc = self._proc
        assert proc.stdout is not None
        tail, result = "", ""
        for raw in proc.stdout:
            line = raw.decode(errors="replace").strip()
            if not line:
                continue
            if line.startswith("PROGRESS "):
                frac = float(line.split()[1])
                if standalone:
                    db.update_song(sid, stage="align", progress=round(frac, 3))
                else:
                    self._progress(sid, "align", frac)
                continue
            if line.startswith("RESULT "):
                result = line[7:]
            elif "Downloading" in line:
                db.update_song(sid, stage="model")
            tail = (tail + "\n" + line)[-2000:]
        code = proc.wait()
        self._check(sid)
        if code != 0:
            raise RuntimeError(f"alignment exited with {code}: {tail.strip().splitlines()[-1] if tail.strip() else ''}")
        log.info("word timing for %s: %s", sid, result)
        if result and not result.startswith("aligned=0/"):
            # The timing already sits on the audio; an old hand-set offset would now shift it twice.
            db.update_song(sid, lyrics_offset=0)

    def _download_audio(self, song: dict[str, Any], folder: Path) -> Path:
        sid = song["id"]
        self._progress(sid, "download", 0, status="downloading")

        def hook(d: dict[str, Any]) -> None:
            self._check(sid)
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                if total:
                    self._progress(sid, "download", d.get("downloaded_bytes", 0) / total)

        opts = {
            **_ydl_base(),
            "format": "bestaudio[acodec=opus]/bestaudio/best",
            "outtmpl": str(folder / "source.%(ext)s"),
            "progress_hooks": [hook],
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={sid}", download=True)
        fields: dict[str, Any] = {}
        if not song.get("duration") and info.get("duration"):
            fields["duration"] = float(info["duration"])
        if not song.get("thumbnail") and info.get("thumbnail"):
            fields["thumbnail"] = info["thumbnail"]
            song["thumbnail"] = info["thumbnail"]
        if fields:
            db.update_song(sid, **fields)
        src = find_source(folder)
        if not src:
            raise RuntimeError("yt-dlp finished but no audio file was written")
        return src

    def _download_cover(self, song: dict[str, Any], folder: Path) -> None:
        url = song.get("thumbnail") or (db.get_song(song["id"]) or {}).get("thumbnail")
        if not url:
            return
        try:
            r = requests.get(ytm.big_thumb(url), timeout=20)
            if r.ok and r.content:
                (folder / "cover.jpg").write_bytes(r.content)
                db.update_song(song["id"], has_cover=1)
        except requests.RequestException:
            pass

    def _separate(self, sid: str, source: Path, folder: Path, settings: dict[str, Any]) -> None:
        self._progress(sid, "separate", 0, status="separating")
        work = folder / ".work"
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir()
        model = settings["model"]
        cmd = [
            sys.executable, "-m", "demucs",
            "-n", model,
            "--two-stems", "vocals",
            "-d", resolve_device(settings["device"]),
            "-o", str(work),
            "--filename", "{stem}.{ext}",
            str(source),
        ]
        log.info("separating %s with %s", sid, model)
        env = {**os.environ, "TORCH_HOME": str(config.MODELS_DIR), "PYTHONUNBUFFERED": "1"}
        with self._lock:
            self._check(sid)
            self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
        proc = self._proc
        assert proc.stdout is not None

        n_models, bar, last_pct, tail = 1, 0, 0.0, ""
        buf = b""
        while True:
            chunk = proc.stdout.read(256)
            if not chunk:
                break
            buf += chunk
            *parts, buf = re.split(rb"[\r\n]", buf)
            for raw in parts:
                line = raw.decode(errors="replace")
                if line.strip():
                    tail = (tail + "\n" + line)[-2000:]
                m = re.search(r"bag of (\d+) models", line)
                if m:
                    n_models = int(m.group(1))
                if "Downloading:" in line:
                    db.update_song(sid, stage="model")
                    continue
                m = re.search(r"(\d+)%\|", line)
                if m and "seconds" in line:
                    pct = int(m.group(1)) / 100
                    if pct < last_pct - 0.2:
                        bar += 1
                    last_pct = pct
                    self._progress(sid, "separate", (min(bar, n_models - 1) + pct) / n_models)
        code = proc.wait()
        self._check(sid)
        if code != 0:
            raise RuntimeError(f"demucs exited with {code}: {tail.strip().splitlines()[-1] if tail.strip() else ''}")

        out = work / model
        vocals, inst = out / "vocals.wav", out / "no_vocals.wav"
        if not (vocals.exists() and inst.exists()):
            raise RuntimeError("demucs did not produce stems")
        self._encode_stems(sid, folder, {"instrumental": inst, "vocals": vocals}, settings)
        db.update_song(sid, model=model)

    def _encode_stems(self, sid: str, folder: Path, wavs: dict[str, Path], settings: dict[str, Any]) -> None:
        """Encode the WAV stems from Demucs in the configured format and replace the old stems."""
        fmt = settings["stem_format"] if settings["stem_format"] in config.STEM_FORMATS else "aac"
        ext = config.STEM_FORMATS[fmt]
        bitrate = int(settings["stem_bitrate"])
        encoded: dict[str, Path] = {}
        for name, wav in wavs.items():
            mono = name == "vocals" and settings.get("mono_vocals", True)
            kbps = max(64, bitrate // 2) if mono else bitrate
            dest = wav.with_name(f"{name}.{ext}")
            cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(wav), "-map_metadata", "-1"]
            if mono:
                cmd += ["-ac", "1"]
            if fmt == "aac":
                cmd += ["-c:a", "aac", "-b:a", f"{kbps}k", "-movflags", "+faststart"]
            else:
                cmd += ["-c:a", "libmp3lame", "-b:a", f"{kbps}k"]
            res = subprocess.run([*cmd, str(dest)], capture_output=True, text=True)
            self._check(sid)
            if res.returncode != 0 or not dest.exists():
                raise RuntimeError(f"ffmpeg could not encode the {name} stem: {res.stderr.strip()[-300:]}")
            encoded[name] = dest
        for name in config.STEM_NAMES:
            for old_ext in config.STEM_FORMATS.values():
                (folder / f"{name}.{old_ext}").unlink(missing_ok=True)
        for name, path in encoded.items():
            shutil.move(str(path), folder / path.name)

    def _download_video(self, song: dict[str, Any], folder: Path, settings: dict[str, Any]) -> None:
        sid = song["id"]
        vid = song.get("video_id") or ytm.find_music_video(song["title"], song["artist"], song["duration"], sid)
        if not vid:
            return
        db.update_song(sid, video_id=vid)
        h = int(settings["video_max_height"])

        def hook(d: dict[str, Any]) -> None:
            self._check(sid)
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                if total:
                    self._progress(sid, "video", d.get("downloaded_bytes", 0) / total)

        opts = {
            **_ydl_base(),
            # Video only (audio comes from the stems), prefer H.264 for Safari.
            "format": f"bv*[height<={h}][vcodec^=avc1]/bv*[height<={h}][ext=mp4]/bv*[height<={h}]/bv*",
            "outtmpl": str(folder / ".work" / "video.%(ext)s"),
            "progress_hooks": [hook],
            "postprocessors": [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}],
        }
        (folder / ".work").mkdir(exist_ok=True)
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([f"https://www.youtube.com/watch?v={vid}"])
        out = folder / ".work" / "video.mp4"
        if out.exists():
            shutil.move(str(out), folder / "video.mp4")


def _short_error(exc: Exception) -> str:
    msg = str(exc).strip() or exc.__class__.__name__
    msg = re.sub(r"\x1b\[[0-9;]*m", "", msg)
    return msg[:500]


worker = Worker()
