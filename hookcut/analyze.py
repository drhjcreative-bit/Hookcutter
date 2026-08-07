"""Signal analysis for footage: scene cuts, audio energy peaks, motion.

These signals drive hook detection for non-dialogue footage (b-roll, gameplay,
screen recordings) and improve cut placement for talking-head clips too.

All heavy deps are optional. Everything degrades gracefully:
  - scene detection uses PySceneDetect if present, else an ffmpeg scene filter,
    else empty.
  - audio energy uses a raw PCM decode via ffmpeg + numpy (no librosa needed).
  - beat detection uses librosa if present (only when --beat-sync).
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
import wave
from dataclasses import dataclass, field
from typing import List, Optional

from .utils import require, run, log, debug, ffprobe


@dataclass
class Signals:
    duration: float
    scene_cuts: List[float] = field(default_factory=list)      # timestamps of cuts
    energy_times: List[float] = field(default_factory=list)    # window centers
    energy: List[float] = field(default_factory=list)          # normalized 0..1 RMS
    peaks: List[float] = field(default_factory=list)           # loud-moment timestamps
    beats: List[float] = field(default_factory=list)           # beat timestamps

    def energy_at(self, t: float) -> float:
        if not self.energy_times:
            return 0.0
        # nearest window
        lo, hi = 0, len(self.energy_times) - 1
        best, bestd = 0, 1e9
        for i, tt in enumerate(self.energy_times):
            d = abs(tt - t)
            if d < bestd:
                bestd, best = d, i
        return self.energy[best]


# ---- scene detection ---------------------------------------------------------
def detect_scenes(video: str, threshold: float = 27.0) -> List[float]:
    try:
        from scenedetect import open_video, SceneManager
        from scenedetect.detectors import ContentDetector
        video_stream = open_video(video)
        sm = SceneManager()
        sm.add_detector(ContentDetector(threshold=threshold))
        sm.detect_scenes(video_stream)
        scenes = sm.get_scene_list()
        cuts = [s[0].get_seconds() for s in scenes][1:]  # skip 0.0
        debug(f"pyscenedetect found {len(cuts)} cuts")
        return cuts
    except ImportError:
        return _detect_scenes_ffmpeg(video, threshold / 100.0)
    except Exception as e:
        debug(f"scenedetect failed: {e}")
        return _detect_scenes_ffmpeg(video, threshold / 100.0)


def _detect_scenes_ffmpeg(video: str, thresh: float = 0.27) -> List[float]:
    require("ffmpeg", "install ffmpeg")
    cmd = ["ffmpeg", "-i", video, "-filter:v",
           f"select='gt(scene,{thresh})',showinfo", "-f", "null", "-"]
    cp = subprocess.run(cmd, capture_output=True, text=True)
    cuts = []
    for m in re.finditer(r"pts_time:([0-9.]+)", cp.stderr or ""):
        cuts.append(float(m.group(1)))
    debug(f"ffmpeg scene filter found {len(cuts)} cuts")
    return sorted(set(cuts))


# ---- audio energy ------------------------------------------------------------
def audio_energy(video: str, window: float = 0.5) -> tuple:
    """Return (times, normalized_rms) sampled in `window`-second buckets."""
    require("ffmpeg", "install ffmpeg")
    info = ffprobe(video)
    if not info.has_audio:
        return [], []
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "a.wav")
        run(["ffmpeg", "-y", "-i", video, "-ac", "1", "-ar", "16000",
             "-vn", wav], capture=True, check=False)
        if not os.path.exists(wav):
            return [], []
        try:
            import numpy as np
        except ImportError:
            log("numpy not installed — audio-energy analysis skipped", level="warn")
            return [], []
        with wave.open(wav, "rb") as wf:
            sr = wf.getframerate()
            n = wf.getnframes()
            raw = wf.readframes(n)
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if data.size == 0:
            return [], []
        win = max(1, int(window * sr))
        times, rms = [], []
        for i in range(0, len(data), win):
            chunk = data[i:i + win]
            if chunk.size == 0:
                continue
            times.append((i + chunk.size / 2) / sr)
            rms.append(float(np.sqrt(np.mean(chunk ** 2))))
        if not rms:
            return [], []
        arr = np.array(rms)
        mn, mx = float(arr.min()), float(arr.max())
        norm = ((arr - mn) / (mx - mn)) if mx > mn else arr * 0
        return times, norm.tolist()


def find_peaks(times: List[float], energy: List[float], k: float = 1.3) -> List[float]:
    if not energy:
        return []
    try:
        import numpy as np
        arr = np.array(energy)
        thr = float(arr.mean() + k * arr.std())
    except ImportError:
        mean = sum(energy) / len(energy)
        thr = mean * (1 + 0.3 * k)
    peaks = []
    for t, e in zip(times, energy):
        if e >= thr:
            if not peaks or (t - peaks[-1]) > 1.5:
                peaks.append(t)
    return peaks


# ---- beats -------------------------------------------------------------------
def detect_beats(audio_path: str) -> List[float]:
    try:
        import librosa
        y, sr = librosa.load(audio_path, sr=None, mono=True)
        _tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
        return [float(b) for b in beats]
    except Exception as e:
        debug(f"beat detection unavailable: {e}")
        return []


def analyze(video: str, settings) -> Signals:
    info = ffprobe(video)
    log(f"analyzing signals: {os.path.basename(video)}", level="step")
    cuts = detect_scenes(video)
    times, energy = audio_energy(video)
    peaks = find_peaks(times, energy)
    beats = []
    if settings.beat_sync and settings.music:
        beats = detect_beats(settings.music)
    debug(f"signals: {len(cuts)} cuts, {len(peaks)} loud peaks")
    return Signals(duration=info.duration, scene_cuts=cuts,
                   energy_times=times, energy=energy, peaks=peaks, beats=beats)
