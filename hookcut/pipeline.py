"""End-to-end orchestration: sources → transcribe → analyze → hooks → plan
→ audit (iterate) → package → render → manifest."""
from __future__ import annotations

import json
import os
from typing import List

from .config import Settings, DURATION_PRESETS
from . import sources, transcribe as T, analyze as A, hooks as H, planner as P
from . import audit as AU, trends as TR, render as R
from .segments import Moment, CutPlan
from .utils import log, debug, ensure_dir, set_verbose


def _tighten(moments: List[Moment], ideal: float) -> List[Moment]:
    """Cap each moment to ~ideal on-screen length to speed up pacing."""
    out = []
    for m in moments:
        m2 = Moment(**{**m.__dict__})
        if m2.dur > ideal * 1.4:
            m2.end = m2.start + ideal
        out.append(m2)
    return out


def _plan_with_audit(moments, signals_by_src, settings, dk, dialogue) -> CutPlan:
    plan = P.plan_duration(moments, signals_by_src, settings, dk)
    if not settings.audit:
        return plan
    plan = AU.audit_plan(plan, settings, dialogue)
    iters = 0
    while plan.audit_score < settings.audit_threshold and iters < settings.max_iterations:
        iters += 1
        band = DURATION_PRESETS.get(dk, 30)
        ideal = 2.2 if band <= 30 else (3.0 if band <= 60 else 4.5)
        log(f"[{dk}s] score {plan.audit_score:.1f} < {settings.audit_threshold} — "
            f"re-planning tighter (iter {iters})", level="step")
        tight = _tighten(moments, ideal)
        cand = P.plan_duration(tight, signals_by_src, settings, dk)
        cand = AU.audit_plan(cand, settings, dialogue)
        if cand.audit_score > plan.audit_score:
            plan = cand
        else:
            break
    return plan


def run(settings: Settings) -> dict:
    set_verbose(settings.verbose)
    ensure_dir(settings.out_dir)

    if settings.refresh_trends and settings.trends_file:
        TR.refresh(settings.trends_file, settings)

    log("resolving inputs…", level="step")
    files = sources.resolve_inputs(settings.inputs, settings.out_dir)
    if not files:
        log("no input videos found. Pass a file, folder, URL, gdrive: or icloud: path.", level="err")
        return {"ok": False, "reason": "no inputs"}
    log(f"{len(files)} source video(s)", level="ok")

    all_moments: List[Moment] = []
    signals_by_src = {}
    transcripts = {}
    dialogue_any = False

    for f in files:
        try:
            tr = T.transcribe(f, settings)
        except RuntimeError as e:
            log(str(e), level="err")
            tr = T.Transcript(language="en", duration=0.0, segments=[])
        tr._source = f
        transcripts[f] = tr
        sig = A.analyze(f, settings)
        signals_by_src[f] = sig
        if len(tr.words) >= 12:
            dialogue_any = True
        moments = H.detect_hooks(tr, sig, settings)
        for m in moments:
            m.source = f
        all_moments += moments

    if not all_moments:
        log("no usable moments detected across inputs", level="err")
        return {"ok": False, "reason": "no moments"}

    trends = TR.Trends(settings)
    mode = settings.mode if settings.mode != "auto" else ("talking" if dialogue_any else "broll")

    manifest = {"sources": files, "aspect": settings.aspect, "mode": mode, "edits": []}
    log(f"packaging {len(settings.durations)} length(s): {', '.join(settings.durations)}", level="step")

    for dk in settings.durations:
        if dk not in DURATION_PRESETS:
            log(f"unknown duration '{dk}', skipping", level="warn")
            continue
        plan = _plan_with_audit(all_moments, signals_by_src, settings, dk, dialogue_any)
        if not plan.clips:
            continue
        trends.write_copy(plan, mode)

        out_video = ""
        if not settings.dry_run:
            out_video = R.render_plan(plan, transcripts, settings)

        # sidecar packaging file
        sidecar = os.path.join(settings.out_dir, f"{plan.duration_key}s_package.txt")
        _write_sidecar(sidecar, plan, out_video)

        manifest["edits"].append({
            "duration": dk,
            "video": out_video,
            "total_seconds": round(plan.total, 2),
            "audit_score": plan.audit_score,
            "audit_notes": plan.audit_notes,
            "title": plan.title,
            "caption": plan.caption_full,
            "hashtags": plan.hashtags,
            "trend_format": plan.trend_format,
            "hook_line": plan.hook_line,
            "clips": [dict(source=os.path.basename(c.source), start=round(c.start, 2),
                           end=round(c.end, 2), role=c.role) for c in plan.clips],
        })

    man_path = os.path.join(settings.out_dir, "manifest.json")
    with open(man_path, "w") as fh:
        json.dump(manifest, fh, indent=2)
    log(f"manifest → {man_path}", level="ok")

    n = len(manifest["edits"])
    log(f"done: {n} edit(s) in {settings.out_dir}/", level="ok")
    return {"ok": True, "manifest": man_path, "edits": manifest["edits"]}


def _write_sidecar(path: str, plan: CutPlan, video: str) -> None:
    lines = [
        f"HOOKCUT · {plan.duration_key}s edit  ({plan.aspect})",
        f"Format: {plan.trend_format}",
        f"Audit:  {plan.audit_score:.1f}/10",
        "",
        f"ON-SCREEN HOOK:\n  {plan.title}",
        "",
        f"CAPTION:\n  {plan.caption_full}",
        "",
        "HASHTAGS:\n  " + " ".join(plan.hashtags),
        "",
        f"OPENING LINE:\n  {plan.hook_line}",
        "",
        f"VIDEO FILE:\n  {video or '(dry-run — not rendered)'}",
    ]
    if plan.audit_notes:
        lines += ["", "AUDIT NOTES:"] + [f"  - {n}" for n in plan.audit_notes]
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
