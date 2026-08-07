"""Cut planning: turn scored moments into a per-duration edit plan.

Strategy per target length:
  1. Pick the single strongest HOOK moment as the opener (role=hook).
  2. Greedily fill the remaining time with the highest-scoring supporting
     moments in chronological order, keeping pace tight and skipping anything
     that overlaps an already-chosen span.
  3. Trim the last clip so total lands within tolerance of the target.
  4. For beat-sync, snap clip boundaries to the nearest music beat.

Extended edits (90-180s) keep more narrative and payoff moments.
"""
from __future__ import annotations

from typing import List

from .segments import Moment, Clip, CutPlan
from .config import DURATION_PRESETS
from .analyze import Signals
from .utils import log, debug, clamp


def _snap_to_beat(t: float, beats: List[float], max_shift: float = 0.25) -> float:
    if not beats:
        return t
    nearest = min(beats, key=lambda b: abs(b - t))
    return nearest if abs(nearest - t) <= max_shift else t


def _non_overlapping(chosen: List[Moment], cand: Moment) -> bool:
    for c in chosen:
        if c.source == cand.source:
            lo = max(c.start, cand.start)
            hi = min(c.end, cand.end)
            if hi - lo > 0.15:
                return False
    return True


def plan_duration(moments: List[Moment], signals_by_src: dict, settings,
                  duration_key: str) -> CutPlan:
    target = DURATION_PRESETS[duration_key]
    if duration_key == "extended":
        target = 150.0
    tol = max(1.5, target * 0.12)

    hooks = sorted([m for m in moments if m.hook >= 4], key=lambda m: m.hook, reverse=True)
    opener = hooks[0] if hooks else (sorted(moments, key=lambda m: m.score, reverse=True)[0]
                                     if moments else None)

    plan = CutPlan(duration_key=duration_key, target=target, aspect=settings.aspect)
    if opener is None:
        log(f"[{duration_key}] no usable moments", level="warn")
        return plan

    chosen: List[Moment] = [opener]
    used_time = _capped(opener, target)

    # candidate pool sorted by score, excluding the opener
    pool = sorted([m for m in moments if m is not opener], key=lambda m: m.score, reverse=True)
    for cand in pool:
        if used_time >= target - tol:
            break
        if not _non_overlapping(chosen, cand):
            continue
        take = _capped(cand, target - used_time + tol)
        if take < settings.min_clip:
            continue
        chosen.append(cand)
        used_time += take

    # order body chronologically per source but keep hook first
    body = sorted([m for m in chosen if m is not opener], key=lambda m: (m.source, m.start))
    ordered = [opener] + body

    # build clips, trim to target, snap to beats
    total = 0.0
    beats = settings.beat_sync and next(iter(signals_by_src.values())).beats or []
    for i, m in enumerate(ordered):
        remaining = target - total
        if remaining <= 0.2:
            break
        dur = min(m.dur, remaining + (tol if i == len(ordered) - 1 else 0))
        dur = max(dur, settings.min_clip)
        start = m.start
        end = m.start + dur
        if beats:
            start = _snap_to_beat(start, beats)
            end = _snap_to_beat(end, beats)
        role = "hook" if m is opener else ("payoff" if i == len(ordered) - 1 else "body")
        plan.clips.append(Clip(source=m.source, start=start, end=end,
                               text=m.text, role=role))
        total += (end - start)

    plan.hook_line = opener.text.strip()
    debug(f"[{duration_key}] {len(plan.clips)} clips, {total:.1f}s (target {target:.0f}s)")
    log(f"planned {duration_key}s edit: {len(plan.clips)} clips, {plan.total:.1f}s", level="ok")
    return plan


def _capped(m: Moment, cap: float) -> float:
    return clamp(m.dur, 0.0, max(0.0, cap))


def plan_all(moments: List[Moment], signals_by_src: dict, settings) -> List[CutPlan]:
    plans = []
    for dk in settings.durations:
        if dk not in DURATION_PRESETS:
            log(f"unknown duration '{dk}', skipping", level="warn")
            continue
        plans.append(plan_duration(moments, signals_by_src, settings, dk))
    return plans
