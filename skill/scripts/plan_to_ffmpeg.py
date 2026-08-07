#!/usr/bin/env python3
"""Turn a chosen cut plan into ffmpeg commands (cut → reframe → concat).

Plan JSON schema (what this skill produces):
{
  "aspect": "9:16",                     # 9:16 | 1:1 | 4:5 | 16:9
  "out": "edit_30s.mp4",
  "cuts": [
    {"source": "interview.mov", "start": 41.2, "end": 44.0},
    {"source": "interview.mov", "start": 72.5, "end": 76.1}
  ]
}

Usage:
  python3 plan_to_ffmpeg.py plan.json            # print commands
  python3 plan_to_ffmpeg.py plan.json --run      # also execute them (needs ffmpeg)

Produces a reframed, concatenated mp4. Add captions/music with the HookCut CLI
or your editor of choice.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile

ASPECTS = {"9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350), "16:9": (1920, 1080)}


def vf_for(aspect: str) -> str:
    tw, th = ASPECTS.get(aspect, ASPECTS["9:16"])
    if tw >= th:  # landscape target -> pad
        return (f"scale={tw}:{th}:force_original_aspect_ratio=decrease,"
                f"pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30")
    return (f"scale={tw}:{th}:force_original_aspect_ratio=increase,"
            f"crop={tw}:{th},setsar=1,fps=30")


def build(plan: dict):
    aspect = plan.get("aspect", "9:16")
    out = plan.get("out", "hookcut_edit.mp4")
    vf = vf_for(aspect)
    parts = []
    cmds = []
    workdir = tempfile.mkdtemp(prefix="hookcut_")
    for i, c in enumerate(plan["cuts"]):
        part = os.path.join(workdir, f"part_{i:03d}.mp4")
        dur = max(0.1, float(c["end"]) - float(c["start"]))
        cmds.append([
            "ffmpeg", "-y", "-ss", f"{float(c['start']):.3f}", "-i", c["source"],
            "-t", f"{dur:.3f}", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
            "-ar", "48000", "-ac", "2", "-avoid_negative_ts", "make_zero", part,
        ])
        parts.append(part)
    listfile = os.path.join(workdir, "concat.txt")
    with open(listfile, "w") as fh:
        for p in parts:
            fh.write(f"file '{p}'\n")
    cmds.append(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listfile,
                 "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                 "-c:a", "aac", "-b:a", "160k", out])
    return cmds, out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("plan")
    ap.add_argument("--run", action="store_true")
    a = ap.parse_args(argv)
    with open(a.plan) as fh:
        plan = json.load(fh)
    cmds, out = build(plan)
    for c in cmds:
        print(" ".join(f"'{x}'" if " " in str(x) else str(x) for x in c))
    if a.run:
        for c in cmds:
            r = subprocess.run(c)
            if r.returncode != 0:
                print(f"ffmpeg failed on: {' '.join(c)}", file=sys.stderr)
                return 1
        print(f"\n✓ wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
