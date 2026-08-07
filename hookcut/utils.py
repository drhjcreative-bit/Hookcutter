"""Shared helpers: logging, ffmpeg/ffprobe wrappers, small math utils."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Optional

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".ts", ".mpg", ".mpeg"}

_VERBOSE = False


def set_verbose(v: bool) -> None:
    global _VERBOSE
    _VERBOSE = v


def log(msg: str, *, level: str = "info") -> None:
    tag = {"info": "•", "ok": "✓", "warn": "!", "err": "✗", "step": "▶"}.get(level, "•")
    stream = sys.stderr if level in ("warn", "err") else sys.stdout
    print(f"{tag} {msg}", file=stream, flush=True)


def debug(msg: str) -> None:
    if _VERBOSE:
        print(f"  · {msg}", file=sys.stderr, flush=True)


def which(name: str) -> Optional[str]:
    return shutil.which(name)


def require(binary: str, hint: str = "") -> str:
    path = which(binary)
    if not path:
        extra = f" — {hint}" if hint else ""
        raise RuntimeError(f"Required tool '{binary}' not found on PATH{extra}")
    return path


def run(cmd: list, *, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess:
    debug("$ " + " ".join(str(c) for c in cmd))
    return subprocess.run(
        [str(c) for c in cmd],
        capture_output=capture,
        text=True,
        check=check,
    )


@dataclass
class MediaInfo:
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool


def ffprobe(path: str) -> MediaInfo:
    """Probe a media file for duration/dimensions/fps/audio."""
    require("ffprobe", "install ffmpeg (brew install ffmpeg)")
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ]
    cp = run(cmd, capture=True)
    data = json.loads(cp.stdout or "{}")
    dur = float(data.get("format", {}).get("duration", 0.0) or 0.0)
    w = h = 0
    fps = 30.0
    has_audio = False
    for s in data.get("streams", []):
        if s.get("codec_type") == "video" and not w:
            w = int(s.get("width", 0) or 0)
            h = int(s.get("height", 0) or 0)
            r = s.get("avg_frame_rate") or s.get("r_frame_rate") or "30/1"
            try:
                num, den = r.split("/")
                fps = (float(num) / float(den)) if float(den) else 30.0
            except Exception:
                fps = 30.0
        if s.get("codec_type") == "audio":
            has_audio = True
    return MediaInfo(duration=dur, width=w, height=h, fps=fps or 30.0, has_audio=has_audio)


def hhmmss(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    if h:
        return f"{h:d}:{m:02d}:{s:06.3f}"
    return f"{m:02d}:{s:06.3f}"


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def ensure_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    return path


def slugify(text: str, maxlen: int = 48) -> str:
    keep = []
    for ch in text.lower().strip():
        if ch.isalnum():
            keep.append(ch)
        elif ch in " -_":
            keep.append("-")
    slug = "".join(keep)
    while "--" in slug:
        slug = slug.replace("--", "-")
    return (slug.strip("-") or "clip")[:maxlen]
