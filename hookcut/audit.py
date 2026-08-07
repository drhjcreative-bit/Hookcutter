"""Self-audit: score a cut plan and return actionable notes.

Blends a deterministic rubric (always on) with an LLM critique (when available).
The pipeline uses the score to decide whether to re-plan tighter.

Rubric (0-10 each, weighted):
  hook_strength   — opener's hook score
  pace            — average clip length vs. ideal for the length band
  duration_fit    — how close total is to target
  coverage        — enough distinct moments / not one long clip
  caption_ready   — captions available for dialogue footage
"""
from __future__ import annotations

from typing import List, Tuple

from . import llm
from .segments import CutPlan
from .utils import clamp, log, debug


def _pace_score(plan: CutPlan) -> Tuple[float, str]:
    if not plan.clips:
        return 0.0, "no clips"
    avg = plan.total / len(plan.clips)
    # ideal average on-screen clip length by band
    band = plan.target
    ideal = 2.2 if band <= 30 else (3.0 if band <= 60 else 4.5)
    dev = abs(avg - ideal) / ideal
    score = clamp(10 - dev * 9, 0, 10)
    note = ""
    if avg > ideal * 1.6:
        note = f"clips run long (avg {avg:.1f}s) — tighten cuts"
    elif avg < ideal * 0.5:
        note = f"cuts very fast (avg {avg:.1f}s) — may feel frantic"
    return score, note


def _duration_score(plan: CutPlan) -> Tuple[float, str]:
    if plan.target <= 0:
        return 5.0, ""
    dev = abs(plan.total - plan.target) / plan.target
    score = clamp(10 - dev * 20, 0, 10)
    note = ""
    if plan.total < plan.target * 0.8:
        note = f"under target ({plan.total:.0f}s / {plan.target:.0f}s) — add a moment"
    elif plan.total > plan.target * 1.2:
        note = f"over target ({plan.total:.0f}s / {plan.target:.0f}s) — trim"
    return score, note


def _coverage_score(plan: CutPlan) -> Tuple[float, str]:
    n = len(plan.clips)
    if plan.target <= 15:
        good = n >= 2
    elif plan.target <= 60:
        good = n >= 3
    else:
        good = n >= 5
    if good:
        return 8.5, ""
    return 5.0, "too few distinct moments — add variety"


def rubric(plan: CutPlan, settings, dialogue: bool) -> Tuple[float, List[str]]:
    hook = plan.clips[0] if plan.clips else None
    hook_score = 8.0
    notes: List[str] = []
    # hook strength inferred from role + presence of hook line
    hs = 7.0
    if plan.hook_line:
        hl = plan.hook_line.lower()
        if any(k in hl for k in ("how", "why", "never", "stop", "the reason",
                                 "mistake", "secret", "?")):
            hs = 8.8
        if len(plan.hook_line.split()) > 18:
            hs -= 1.5
            notes.append("hook line is wordy — front-load the payoff")
    else:
        hs = 6.0
        notes.append("no strong verbal hook detected")

    pace, pnote = _pace_score(plan)
    dur, dnote = _duration_score(plan)
    cov, cnote = _coverage_score(plan)
    cap = 9.0
    if dialogue and settings.captions and settings.caption_style != "none":
        cap = 9.0
    elif dialogue:
        cap = 6.5
        notes.append("dialogue footage without captions — enable captions")

    for nt in (pnote, dnote, cnote):
        if nt:
            notes.append(nt)

    weights = {"hook": 0.32, "pace": 0.22, "dur": 0.16, "cov": 0.15, "cap": 0.15}
    total = (hs * weights["hook"] + pace * weights["pace"] + dur * weights["dur"]
             + cov * weights["cov"] + cap * weights["cap"])
    debug(f"[{plan.duration_key}] rubric hook={hs:.1f} pace={pace:.1f} dur={dur:.1f} "
          f"cov={cov:.1f} cap={cap:.1f} -> {total:.2f}")
    return round(total, 2), notes


def llm_critique(plan: CutPlan, settings) -> Tuple[float, List[str]]:
    if not llm.available(settings):
        return -1.0, []
    seq = "\n".join(f"{i+1}. [{c.role}] {c.text[:120]}" for i, c in enumerate(plan.clips))
    prompt = (
        f"Critique this {plan.duration_key}s short-form edit as a retention-obsessed editor.\n"
        f"Hook line: {plan.hook_line!r}\nTotal: {plan.total:.1f}s (target {plan.target:.0f}s)\n"
        f"Sequence:\n{seq}\n\n"
        "Return ONLY JSON: {\"score\": 0-10, \"notes\": [\"...\", ...]}. "
        "Score on scroll-stopping hook, pacing, and payoff. Notes must be specific and fixable."
    )
    data = llm.ask(prompt, settings, as_json=True, max_tokens=600, temperature=0.2)
    if isinstance(data, dict) and "score" in data:
        try:
            notes = [str(n) for n in data.get("notes", [])][:5]
            return clamp(float(data["score"]), 0, 10), notes
        except Exception:
            return -1.0, []
    return -1.0, []


def audit_plan(plan: CutPlan, settings, dialogue: bool) -> CutPlan:
    r_score, r_notes = rubric(plan, settings, dialogue)
    l_score, l_notes = llm_critique(plan, settings)
    if l_score >= 0:
        final = round(0.5 * r_score + 0.5 * l_score, 2)
        notes = (l_notes + r_notes)[:6]
    else:
        final = r_score
        notes = r_notes
    plan.audit_score = final
    plan.audit_notes = notes
    tag = "ok" if final >= settings.audit_threshold else "warn"
    log(f"audit [{plan.duration_key}s]: {final:.1f}/10" +
        (f" — {notes[0]}" if notes else ""), level=tag)
    return plan
