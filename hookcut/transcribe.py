"""Transcription with word-level timestamps via faster-whisper.

Produces a list of Word and Segment objects and caches the result next to
the source file as <video>.hookcut.json so re-runs are instant.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from typing import List, Optional

from .utils import log, debug


@dataclass
class Word:
    start: float
    end: float
    text: str
    prob: float = 1.0


@dataclass
class Segment:
    start: float
    end: float
    text: str
    words: List[Word] = field(default_factory=list)


@dataclass
class Transcript:
    language: str
    duration: float
    segments: List[Segment] = field(default_factory=list)

    @property
    def words(self) -> List[Word]:
        out = []
        for s in self.segments:
            out.extend(s.words)
        return out

    @property
    def full_text(self) -> str:
        return " ".join(s.text.strip() for s in self.segments).strip()

    def to_dict(self) -> dict:
        return {
            "language": self.language,
            "duration": self.duration,
            "segments": [
                {"start": s.start, "end": s.end, "text": s.text,
                 "words": [asdict(w) for w in s.words]}
                for s in self.segments
            ],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Transcript":
        segs = []
        for s in d.get("segments", []):
            words = [Word(**w) for w in s.get("words", [])]
            segs.append(Segment(start=s["start"], end=s["end"], text=s["text"], words=words))
        return cls(language=d.get("language", "en"), duration=d.get("duration", 0.0), segments=segs)


def _cache_path(video: str) -> str:
    return os.path.splitext(video)[0] + ".hookcut.json"


def load_cache(video: str) -> Optional[Transcript]:
    cp = _cache_path(video)
    if os.path.exists(cp):
        try:
            with open(cp) as fh:
                return Transcript.from_dict(json.load(fh))
        except Exception:
            return None
    return None


def save_cache(video: str, tr: Transcript) -> None:
    try:
        with open(_cache_path(video), "w") as fh:
            json.dump(tr.to_dict(), fh)
    except Exception as e:
        debug(f"could not write transcript cache: {e}")


def transcribe(video: str, settings) -> Transcript:
    """Transcribe a video, using cache when available."""
    cached = load_cache(video)
    if cached is not None:
        log(f"transcript cache hit: {os.path.basename(video)}", level="ok")
        return cached

    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise RuntimeError(
            "faster-whisper is required for transcription. "
            "Install it with: pip install faster-whisper"
        ) from e

    device = settings.device
    compute = settings.compute_type
    if device == "auto":
        device = "cpu"
        compute = "int8" if compute == "auto" else compute
        try:
            import torch  # noqa
            if torch.cuda.is_available():
                device, compute = "cuda", ("float16" if settings.compute_type == "auto" else compute)
        except Exception:
            pass
    elif compute == "auto":
        compute = "int8" if device == "cpu" else "float16"

    log(f"transcribing {os.path.basename(video)} (whisper={settings.whisper_model}, {device}/{compute})…", level="step")
    model = WhisperModel(settings.whisper_model, device=device, compute_type=compute)
    seg_iter, info = model.transcribe(
        video,
        language=settings.language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 350},
    )

    segments: List[Segment] = []
    for s in seg_iter:
        words = []
        for w in (s.words or []):
            words.append(Word(start=float(w.start), end=float(w.end),
                              text=w.word, prob=float(getattr(w, "probability", 1.0) or 1.0)))
        segments.append(Segment(start=float(s.start), end=float(s.end),
                                text=s.text.strip(), words=words))

    tr = Transcript(language=info.language, duration=float(info.duration or 0.0), segments=segments)
    save_cache(video, tr)
    log(f"transcribed {len(segments)} segments, {len(tr.words)} words", level="ok")
    return tr
