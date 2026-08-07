"""Hook detection: find the moments most likely to stop the scroll.

Two engines, blended:
  1. LLM engine (Claude) — reads the transcript and scores/labels moments
     with an editor's eye for open loops, stakes, specificity, and payoff.
  2. Heuristic engine — always available, no API needed. Scores spoken lines
     by hook markers + audio energy + position, and scores non-dialogue
     footage from scene cuts and loudness peaks.

Blending: when the LLM is available its scores dominate but are floored by the
heuristic so nothing strong gets dropped on a bad parse.
"""
from __future__ import annotations

import re
from typing import List

from . import llm
from .segments import Moment
from .transcribe import Transcript
from .analyze import Signals
from .utils import log, debug, clamp

# curiosity / stakes / specificity markers that correlate with strong openers
_HOOK_MARKERS = [
    r"\bhow to\b", r"\bwhy\b", r"\bthe reason\b", r"\bthe secret\b", r"\bnobody\b",
    r"\bmost people\b", r"\bstop\b", r"\bnever\b", r"\balways\b", r"\bmistake\b",
    r"\bthe truth\b", r"\bwhat if\b", r"\bhere'?s\b", r"\bthis is why\b",
    r"\byou need to\b", r"\bi (?:tried|built|made|spent|quit|lost|found)\b",
    r"\bin \d+ (?:seconds|minutes|days|steps|ways)\b", r"\bthe #?1\b",
    r"\bbiggest\b", r"\bhack\b", r"\bframework\b", r"\bactually\b",
]
_NUM_RE = re.compile(r"\b\d+\b")
_Q_RE = re.compile(r"\?")


def _sentence_moments(tr: Transcript) -> List[Moment]:
    """Split transcript into sentence-ish spans with word-timed boundaries."""
    moments: List[Moment] = []
    for seg in tr.segments:
        if not seg.words:
            moments.append(Moment(start=seg.start, end=seg.end, text=seg.text.strip(), kind="talk"))
            continue
        cur = []
        start = seg.words[0].start
        for w in seg.words:
            cur.append(w)
            if re.search(r"[.!?]$", w.text.strip()) or (w.end - start) > 6.0:
                text = "".join(x.text for x in cur).strip()
                if text:
                    moments.append(Moment(start=start, end=w.end, text=text, kind="talk"))
                cur = []
                start = w.end
        if cur:
            text = "".join(x.text for x in cur).strip()
            if text:
                moments.append(Moment(start=start, end=cur[-1].end, text=text, kind="talk"))
    return moments


def _heuristic_score(m: Moment, sig: Signals, total_dur: float) -> None:
    text = m.text.lower()
    score = 3.0
    hook = 2.0
    for pat in _HOOK_MARKERS:
        if re.search(pat, text):
            score += 0.8
            hook += 1.1
    if _Q_RE.search(m.text):
        hook += 1.2
        score += 0.4
    if _NUM_RE.search(m.text):
        hook += 0.7
        score += 0.5
    wc = len(text.split())
    if 4 <= wc <= 14:            # punchy
        hook += 0.8
    elif wc > 30:
        hook -= 0.8
    # audio energy under this span
    e = sig.energy_at((m.start + m.end) / 2) if sig.energy_times else 0.0
    score += 2.0 * e
    hook += 1.0 * e
    # earlier = better hook candidate
    if total_dur > 0:
        rel = m.start / total_dur
        hook += clamp(1.2 * (1 - rel), 0, 1.2)
    m.score = clamp(score, 0, 10)
    m.hook = clamp(hook, 0, 10)
    if m.hook >= 6:
        m.reason = "strong opener markers"
    elif m.score >= 6:
        m.reason = "high interest"


def _broll_moments(sig: Signals, min_clip: float) -> List[Moment]:
    """Build candidate action moments from scene cuts + loudness peaks."""
    moments: List[Moment] = []
    cuts = sorted(set([0.0] + sig.scene_cuts + [sig.duration]))
    for a, b in zip(cuts, cuts[1:]):
        if b - a < min_clip:
            continue
        e = max((sig.energy_at(t) for t in (a, (a + b) / 2, b)), default=0.0)
        moments.append(Moment(start=a, end=min(b, a + 6.0), score=clamp(4 + 5 * e, 0, 10),
                              hook=clamp(3 + 5 * e, 0, 10), kind="broll",
                              reason="scene change / motion"))
    for p in sig.peaks:
        moments.append(Moment(start=max(0, p - 1.0), end=min(sig.duration, p + 2.0),
                              score=8.0, hook=6.5, kind="peak", reason="loud/action peak"))
    return moments


def _llm_hooks(tr: Transcript, settings) -> List[Moment]:
    if not llm.available(settings) or not tr.full_text.strip():
        return []
    # Compact, timestamped transcript for the model
    lines = []
    for i, s in enumerate(tr.segments):
        lines.append(f"[{s.start:.1f}-{s.end:.1f}] {s.text.strip()}")
    body = "\n".join(lines)[:14000]
    prompt = (
        "Below is a timestamped transcript of raw footage. Identify the moments "
        "that would make the STRONGEST short-form hooks and the most watchable "
        "supporting moments.\n\n"
        "For each, return an object with: start, end (seconds, from the timestamps), "
        "text (verbatim), score (0-10 overall watchability), hook (0-10 scroll-stopping "
        "opener strength), reason (<=8 words).\n"
        "Prefer open loops, concrete stakes, specific numbers, tension, and payoff. "
        "Return 6-15 moments.\n\n"
        "Respond ONLY as JSON: {\"moments\": [ ... ]}.\n\n"
        f"TRANSCRIPT:\n{body}"
    )
    data = llm.ask(prompt, settings, as_json=True, max_tokens=2500)
    out: List[Moment] = []
    if isinstance(data, dict):
        for m in data.get("moments", []):
            try:
                out.append(Moment(
                    start=float(m["start"]), end=float(m["end"]),
                    text=str(m.get("text", "")).strip(),
                    score=clamp(float(m.get("score", 5)), 0, 10),
                    hook=clamp(float(m.get("hook", 5)), 0, 10),
                    reason=str(m.get("reason", "")).strip(), kind="talk"))
            except Exception:
                continue
    debug(f"LLM proposed {len(out)} moments")
    return out


def detect_hooks(tr: Transcript, sig: Signals, settings) -> List[Moment]:
    """Return scored moments for a single source, sorted by score desc."""
    mode = settings.mode
    dialogue = len(tr.words) >= 12
    if mode == "auto":
        mode = "talking" if dialogue else "broll"

    heuristics: List[Moment] = []
    if mode in ("talking", "mixed") or dialogue:
        heuristics = _sentence_moments(tr)
        for m in heuristics:
            _heuristic_score(m, sig, tr.duration or sig.duration)
    if mode in ("broll", "gameplay", "mixed") or not dialogue:
        heuristics += _broll_moments(sig, settings.min_clip)

    # LLM pass (talking / mixed only — needs words)
    llm_moments = _llm_hooks(tr, settings) if dialogue and mode in ("talking", "mixed") else []

    moments = _blend(heuristics, llm_moments)
    for m in moments:
        m.source = getattr(tr, "_source", m.source)
    moments.sort(key=lambda x: x.score, reverse=True)
    n_hooks = sum(1 for m in moments if m.hook >= 6)
    log(f"found {len(moments)} moments ({n_hooks} strong hooks) via {mode} mode", level="ok")
    return moments


def _overlap(a: Moment, b: Moment) -> float:
    lo = max(a.start, b.start)
    hi = min(a.end, b.end)
    return max(0.0, hi - lo)


def _blend(heur: List[Moment], llm_m: List[Moment]) -> List[Moment]:
    if not llm_m:
        return heur
    merged = list(llm_m)
    for h in heur:
        # keep heuristic moment only if it doesn't strongly overlap an LLM one
        if all(_overlap(h, l) / (min(h.dur, l.dur) or 1) < 0.5 for l in llm_m):
            h.score = min(h.score, 6.5)  # LLM-picked moments should rank first
            merged.append(h)
    return merged
