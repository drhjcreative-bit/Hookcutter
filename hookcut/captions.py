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

from . import theme as TH
from .transcribe import Transcript, Word
from .segments import CutPlan
from .utils import debug


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


def _group_lines(words: List[Tuple[float, float, str]], layout: TH.CaptionLayout):
    """Group words into short caption lines for punchy pacing (see layout tokens)."""
    lines = []
    cur = []
    cur_len = 0
    for ws, we, tok in words:
        if cur and (cur_len + len(tok) + 1 > layout.max_chars
                    or len(cur) >= layout.max_words):
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
    th = TH.resolve(settings)
    pal, layout = th.palette, th.layout
    m = th.metrics(W, H, size_px=getattr(settings, "caption_size", 0))

    fill = TH.to_ass_color(pal.fill)
    highlight = TH.to_ass_color(pal.highlight)
    outline = TH.to_ass_color(pal.outline)
    shadow = TH.to_ass_color(pal.shadow, alpha=pal.shadow_alpha)
    bold = -1 if layout.bold else 0
    fontname = os.path.basename(th.font).rsplit(".", 1)[0] if th.font else "Arial"

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Base,{fontname},{m.size},{fill},{highlight},{outline},{shadow},{bold},0,0,0,100,100,0,0,1,{layout.outline_w},{layout.shadow_w},{layout.align},{m.gutter},{m.gutter},{m.safe_bottom},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    lines = _group_lines(words, layout)
    cased = (lambda s: s.upper()) if layout.uppercase else (lambda s: s)
    for line in lines:
        l_start = line[0][0]
        l_end = line[-1][1]
        if settings.caption_style == "karaoke":
            parts = []
            for ws, we, tok in line:
                cs = max(1, int(round((we - ws) * 100)))
                parts.append(f"{{\\k{cs}}}{cased(tok)} ")
            text = "".join(parts).strip()
        else:
            text = " ".join(cased(tok) for _ws, _we, tok in line)
        events.append(
            f"Dialogue: 0,{_ass_time(l_start)},{_ass_time(l_end)},Base,,0,0,0,,{text}"
        )

    ass_path = os.path.join(settings.out_dir, f"_captions_{plan.duration_key}.ass")
    with open(ass_path, "w", encoding="utf-8") as fh:
        fh.write(header + "\n".join(events) + "\n")
    debug(f"wrote {len(events)} caption lines → {ass_path}")
    return ass_path
