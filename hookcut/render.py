"""Rendering: cut, reframe to target aspect, concat, caption, and mix music.

Pipeline per plan:
  1. Extract & re-encode each clip to a common format at the target aspect
     (smart center-crop to 9:16/1:1/4:5, or pad for 16:9).
  2. Concat clips.
  3. Burn ASS captions (optional).
  4. Duck a music bed under the voice (optional).

Everything shells out to ffmpeg. Uniform intermediate encoding avoids concat
glitches across mixed source resolutions/codecs.
"""
from __future__ import annotations

import os
import tempfile
from typing import List

from .segments import CutPlan
from .config import ASPECTS
from .captions import build_ass
from .theme import PAD_BACKGROUND
from .utils import require, run, log, debug, ensure_dir, slugify, hhmmss


def _scale_crop_filter(tw: int, th: int) -> str:
    # scale to cover, then center-crop to exact target
    return (f"scale={tw}:{th}:force_original_aspect_ratio=increase,"
            f"crop={tw}:{th},setsar=1")


def _pad_filter(tw: int, th: int) -> str:
    return (f"scale={tw}:{th}:force_original_aspect_ratio=decrease,"
            f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:{PAD_BACKGROUND},setsar=1")


def _clip_filter(aspect: str) -> str:
    tw, th = ASPECTS.get(aspect, ASPECTS["9:16"])
    # landscape target -> pad; portrait/square target -> crop to fill
    if tw >= th:
        return _pad_filter(tw, th)
    return _scale_crop_filter(tw, th)


def _render_clip(src: str, start: float, end: float, out: str, aspect: str, fps: int = 30):
    vf = _clip_filter(aspect)
    dur = max(0.1, end - start)
    cmd = [
        "ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", src, "-t", f"{dur:.3f}",
        "-vf", f"{vf},fps={fps}", "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
        "-avoid_negative_ts", "make_zero", out,
    ]
    run(cmd, capture=True, check=False)
    return os.path.exists(out) and os.path.getsize(out) > 0


def _concat(clips: List[str], out: str):
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
        listfile = fh.name
        for c in clips:
            fh.write(f"file '{os.path.abspath(c)}'\n")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listfile,
         "-c", "copy", out], capture=True, check=False)
    if not (os.path.exists(out) and os.path.getsize(out) > 0):
        # fallback: re-encode concat
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listfile,
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
             "-c:a", "aac", "-b:a", "160k", out], capture=True, check=False)
    os.unlink(listfile)
    return os.path.exists(out)


def _apply_captions_and_music(video: str, ass: str, out: str, settings):
    filters = []
    inputs = ["-i", video]
    if ass:
        esc = ass.replace("\\", "/").replace(":", r"\:").replace("'", r"\'")
        fontdir = os.path.dirname(settings.font) if settings.font else ""
        fdir = f":fontsdir='{fontdir}'" if fontdir else ""
        filters.append(f"[0:v]ass='{esc}'{fdir}[v]")
    vmap = "[v]" if ass else "0:v"

    if settings.music and os.path.exists(settings.music):
        inputs += ["-stream_loop", "-1", "-i", settings.music]
        # duck music under voice
        filters.append(
            f"[1:a]volume={settings.music_db}dB[bg];"
            f"[0:a][bg]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=250[aduck];"
            f"[0:a][aduck]amix=inputs=2:duration=first:weights=1 0.6[a]"
        )
        amap = "[a]"
    else:
        amap = "0:a"

    cmd = ["ffmpeg", "-y"] + inputs
    if filters:
        cmd += ["-filter_complex", ";".join(filters)]
    cmd += ["-map", vmap, "-map", amap, "-shortest",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", out]
    run(cmd, capture=True, check=False)
    return os.path.exists(out) and os.path.getsize(out) > 0


def render_plan(plan: CutPlan, transcripts: dict, settings) -> str:
    require("ffmpeg", "install ffmpeg (brew install ffmpeg)")
    if not plan.clips:
        log(f"[{plan.duration_key}] nothing to render", level="warn")
        return ""

    ensure_dir(settings.out_dir)
    work = ensure_dir(os.path.join(settings.out_dir, f"_work_{plan.duration_key}"))
    res = ASPECTS.get(settings.aspect, ASPECTS["9:16"])

    log(f"rendering {plan.duration_key}s edit ({len(plan.clips)} clips, {plan.aspect})…", level="step")
    rendered = []
    for i, clip in enumerate(plan.clips):
        part = os.path.join(work, f"part_{i:03d}.mp4")
        debug(f"clip {i}: {os.path.basename(clip.source)} {hhmmss(clip.start)}→{hhmmss(clip.end)} ({clip.role})")
        if _render_clip(clip.source, clip.start, clip.end, part, settings.aspect):
            rendered.append(part)
    if not rendered:
        log(f"[{plan.duration_key}] all clip renders failed", level="err")
        return ""

    concat_out = os.path.join(work, "concat.mp4")
    _concat(rendered, concat_out)

    ass = build_ass(plan, transcripts, settings, res=res)

    slug = slugify(plan.hook_line or plan.title or "hookcut")
    final = os.path.join(settings.out_dir, f"{slug}_{plan.duration_key}s_{settings.aspect.replace(':','x')}.mp4")
    if ass or (settings.music and os.path.exists(settings.music)):
        ok = _apply_captions_and_music(concat_out, ass, final, settings)
        if not ok:
            os.replace(concat_out, final)
    else:
        os.replace(concat_out, final)

    log(f"{plan.duration_key}s → {final}", level="ok")
    return final
