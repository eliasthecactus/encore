"""Paths and user settings.

Everything persistent lives in two mounted folders:
  ENCORE_CONFIG_DIR  (default /config):  config.json, encore.db, models/, backgrounds/, cookies.txt
  ENCORE_LIBRARY_DIR (default /library): one folder per processed song
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

CONFIG_DIR = Path(os.environ.get("ENCORE_CONFIG_DIR", "/config")).resolve()
LIBRARY_DIR = Path(os.environ.get("ENCORE_LIBRARY_DIR", "/library")).resolve()
STATIC_DIR = Path(os.environ.get("ENCORE_STATIC_DIR", Path(__file__).parent / "static")).resolve()

DB_PATH = CONFIG_DIR / "encore.db"
CONFIG_PATH = CONFIG_DIR / "config.json"
MODELS_DIR = CONFIG_DIR / "models"
BACKGROUNDS_DIR = CONFIG_DIR / "backgrounds"
COOKIES_PATH = CONFIG_DIR / "cookies.txt"

# Separation models offered in the UI (all Demucs v4 variants).
MODELS = {
    "htdemucs": "Hybrid Transformer Demucs (fast, good)",
    "htdemucs_ft": "Hybrid Transformer Demucs fine-tuned (about 4x slower, best)",
    "mdx_extra": "MDX extra (older, solid)",
}

BACKGROUNDS = ["aurora", "visualizer", "cover", "video", "custom"]

# Stem files: AAC in .m4a (smaller at the same quality, decodes everywhere) or MP3.
STEM_FORMATS = {"aac": "m4a", "mp3": "mp3"}
STEM_NAMES = ("instrumental", "vocals")


def stem_file(folder: Path, name: str) -> Path | None:
    """The stem file of a song in whichever format it was encoded."""
    for ext in STEM_FORMATS.values():
        p = folder / f"{name}.{ext}"
        if p.exists():
            return p
    return None

DEFAULTS: dict[str, Any] = {
    "model": "htdemucs",
    "device": "auto",  # auto | cpu | cuda | mps
    "stem_format": "aac",  # aac | mp3, applies to newly processed songs
    "stem_bitrate": 160,  # kbps for the stereo instrumental; a mono vocal stem gets half
    "mono_vocals": True,  # vocals sit in the centre, a mono stem halves their size and memory
    "download_video": True,  # fetch the music video (muted, <=720p) as a background option
    "video_max_height": 720,
    "default_vocals": 0.0,  # 0..1, vocal level when a song starts
    "default_background": "aurora",
    "custom_background": "",  # file name inside backgrounds/
    "lyrics_sources": ["lrclib", "ytmusic"],
    "lyrics_font_scale": 1.0,
    "align_lyrics": True,  # word timing from the vocal stem (MMS_FA, ~1.2 GB model download once)
    "auto_advance": True,  # play the next queued song automatically
    "preload_next": True,  # download the next queued song's stems while the current one plays
    "countdown_seconds": 5,
    "ytmusic_language": "en",
    "concurrent_jobs": 1,
}

_lock = threading.Lock()
_settings: dict[str, Any] = {}


def ensure_dirs() -> None:
    for d in (CONFIG_DIR, LIBRARY_DIR, MODELS_DIR, BACKGROUNDS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def _env_overrides() -> dict[str, Any]:
    """ENCORE_MODEL=htdemucs_ft etc. override the stored settings on startup."""
    out: dict[str, Any] = {}
    for key, default in DEFAULTS.items():
        raw = os.environ.get(f"ENCORE_{key.upper()}")
        if raw is None:
            continue
        if isinstance(default, bool):
            out[key] = raw.lower() in ("1", "true", "yes", "on")
        elif isinstance(default, int):
            out[key] = int(raw)
        elif isinstance(default, float):
            out[key] = float(raw)
        elif isinstance(default, list):
            out[key] = [x.strip() for x in raw.split(",") if x.strip()]
        else:
            out[key] = raw
    return out


def load() -> dict[str, Any]:
    global _settings
    with _lock:
        stored: dict[str, Any] = {}
        if CONFIG_PATH.exists():
            try:
                stored = json.loads(CONFIG_PATH.read_text())
            except json.JSONDecodeError:
                stored = {}
        stored = {k: v for k, v in stored.items() if k in DEFAULTS}  # drops retired keys like mp3_bitrate
        _settings = {**DEFAULTS, **stored, **_env_overrides()}
        _write(_settings)
        return dict(_settings)


def get() -> dict[str, Any]:
    with _lock:
        return dict(_settings)


def update(patch: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        for key, value in patch.items():
            if key not in DEFAULTS:
                continue
            default = DEFAULTS[key]
            if isinstance(default, bool):
                value = bool(value)
            elif isinstance(default, int) and not isinstance(default, bool):
                value = int(value)
            elif isinstance(default, float):
                value = float(value)
            _settings[key] = value
        if _settings.get("model") not in MODELS:
            _settings["model"] = DEFAULTS["model"]
        if _settings.get("stem_format") not in STEM_FORMATS:
            _settings["stem_format"] = DEFAULTS["stem_format"]
        _settings["stem_bitrate"] = min(320, max(64, int(_settings["stem_bitrate"])))
        if _settings.get("default_background") not in BACKGROUNDS:
            _settings["default_background"] = DEFAULTS["default_background"]
        _settings["default_vocals"] = min(1.0, max(0.0, float(_settings["default_vocals"])))
        _write(_settings)
        return dict(_settings)


def _write(data: dict[str, Any]) -> None:
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(CONFIG_PATH)
