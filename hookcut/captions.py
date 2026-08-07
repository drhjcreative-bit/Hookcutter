"""Build burned-in captions as ASS subtitle files from word timestamps.

Two styles:
  - karaoke: word-by-word highlight (the sticky TikTok look), using \\k timing.
  - block:   one line at a time, no per-word highlight.

Captions are generated against the *edited timeline* — i.e. after clips are
concatenated — so timings are remapped to the output video's clock.
"""
from __future__ import annotations

import os
from typing import List, Tuple

from .transcribe import Transcript, Word
from .segments import CutPlan
from .utils import debug


def _hex_to_ass(color: str, alpha: str = "00") -> str:
    color = color.lstrip("#")
    if len(color) != 6:
        color = "F5D90A"
    r, g, b = color[0:2], color[2:4], color[4:6]
    return f"&H{alpha}{b}{g}{r}".upper()


def _ass_time(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    cs = int(round((t - int(t)) * 100))
    if cs == 100:
        cs = 0
        s += 1
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def _collect_words(plan: CutPlan, transcripts: dict) -> List[Tuple[float, float, str]]:
    """Map source-time words onto the edited output timeline."""
    out: List[Tuple[float, float, str]] = []
    t_cursor = 0.0
    for clip in plan.clips:
        tr: Transcript = transcripts.get(clip.source)
        clip_words: List[Word] = []
        if tr:
            for w in tr.words:
                if w.end > clip.start and w.start < clip.end:
                    clip_words.append(w)
        for w in clip_words:
            ws = max(w.start, clip.start) - clip.start + t_cursor
            we = min(w.end, clip.end) - clip.start + t_cursor
            token = w.text.strip()
            if token and we > ws:
                out.append((ws, we, token))
        t_cursor += clip.dur
    return out


def _group_lines(words: List[Tuple[float, float, str]], max_chars: int = 22):
    """Group words into short caption lines (2-4 words) for punchy pacing."""
    lines = []
    cur = []
    cur_len = 0
    for ws, we, tok in words:
        if cur and (cur_len + len(tok) + 1 > max_chars or len(cur) >= 4):
            lines.append(cur)
            cur, cur_len = [], 0
        cur.append((ws, we, tok))
        cur_len += len(tok) + 1
    if cur:
        lines.append(cur)
    return lines


def build_ass(plan: CutPlan, transcripts: dict, settings, res=(1080, 1920)) -> str:
    """Return path to a generated .ass file, or '' if no captions."""
    if settings.caption_style == "none" or not settings.captions:
        return ""
    words = _collect_words(plan, transcripts)
    if not words:
        debug("no words to caption")
        return ""

    W, H = res
    hi = _hex_to_ass(settings.highlight_color)
    white = _hex_to_ass("FFFFFF")
    size = settings.caption_size
    fontname = os.path.basename(settings.font).rsplit(".", 1)[0] if settings.font else "Arial"
    margin_v = int(H * 0.16)

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Base,{fontname},{size},{white},{hi},&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,2,60,60,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    lines = _group_lines(words)
    for line in lines:
        l_start = line[0][0]
        l_end = line[-1][1]
        if settings.caption_style == "karaoke":
            parts = []
            for ws, we, tok in line:
                cs = max(1, int(round((we - ws) * 100)))
                parts.append(f"{{\\k{cs}}}{tok.upper()} ")
            text = "".join(parts).strip()
        else:
            text = " ".join(tok.upper() for _ws, _we, tok in line)
        events.append(
            f"Dialogue: 0,{_ass_time(l_start)},{_ass_time(l_end)},Base,,0,0,0,,{text}"
        )

    ass_path = os.path.join(settings.out_dir, f"_captions_{plan.duration_key}.ass")
    with open(ass_path, "w", encoding="utf-8") as fh:
        fh.write(header + "\n".join(events) + "\n")
    debug(f"wrote {len(events)} caption lines → {ass_path}")
    return ass_path
