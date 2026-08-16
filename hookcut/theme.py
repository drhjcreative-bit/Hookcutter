"""Design tokens for everything HookCut renders or prints.

Two surfaces carry this product's visual identity, and neither is a screen:

  * **burned-in captions** on the rendered video (ASS subtitles)
  * **status output** in the terminal

Both are authored here so a value is written once and reused, instead of
living as a hex literal in ``config.py``, a duplicate literal in ``cli.py``,
and a run of positional magic numbers inside an ASS style string.

Sizes and gutters are stored as *ratios of the canvas*, not pixels. Type and
side gutters scale off the canvas **short edge**; the bottom safe area scales
off **height**. Every preset in ``config.ASPECTS`` is 1080 on its short edge,
so the shipped pixel values are unchanged — but a 4K canvas now gets
proportionally sized captions instead of hairline text.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Dict

# ---- Color -------------------------------------------------------------------


@dataclass(frozen=True)
class CaptionPalette:
    """Semantic caption colors, authored as ``#RRGGBB``.

    ``fill`` and ``highlight`` map onto ASS ``PrimaryColour`` /
    ``SecondaryColour``. Under ``\\k`` karaoke timing a word is drawn in
    ``highlight`` until its moment arrives and in ``fill`` once spoken — so
    ``highlight`` is the *pending* accent and ``fill`` is the *spoken* state.
    """

    fill: str        # spoken word (ASS PrimaryColour)
    highlight: str   # pending word / karaoke accent (ASS SecondaryColour)
    outline: str     # stroke that lifts type off unpredictable footage
    shadow: str      # drop shadow beneath the stroke
    shadow_alpha: int = 0x80   # ASS alpha: 0x00 opaque … 0xFF invisible


PALETTES: Dict[str, CaptionPalette] = {
    # The shipped look: yellow accent resolving to white, heavy near-black stroke.
    "default": CaptionPalette(
        fill="#FFFFFF",
        highlight="#F5D90A",
        outline="#101010",
        shadow="#000000",
    ),
    # No accent hue — for footage the yellow fights with. Dim resolves to bright,
    # so the karaoke read survives without introducing a second brand color.
    "mono": CaptionPalette(
        fill="#FFFFFF",
        highlight="#9A9A9A",
        outline="#101010",
        shadow="#000000",
    ),
}

DEFAULT_THEME = "default"

# Letterbox fill when padding to a landscape target.
PAD_BACKGROUND = "black"


def to_ass_color(hex_color: str, alpha: int = 0x00) -> str:
    """``#RRGGBB`` → ASS ``&HAABBGGRR``. Falls back to the default accent."""
    value = (hex_color or "").lstrip("#")
    if len(value) != 6:
        value = PALETTES[DEFAULT_THEME].highlight.lstrip("#")
    r, g, b = value[0:2], value[2:4], value[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


# ---- Geometry & rhythm -------------------------------------------------------


@dataclass(frozen=True)
class CaptionLayout:
    """Caption geometry, as canvas ratios plus stroke weights in pixels."""

    size: float = 0.0593        # font size ÷ short edge  → 64 @1080
    gutter: float = 0.0556      # side margin ÷ short edge → 60 @1080
    safe_bottom: float = 0.16   # bottom margin ÷ height
    outline_w: int = 6
    shadow_w: int = 2
    bold: bool = True
    uppercase: bool = True
    max_chars: int = 22         # per caption line — keeps the pace punchy
    max_words: int = 4
    align: int = 2              # ASS numpad alignment; 2 = bottom center


@dataclass(frozen=True)
class CaptionMetrics:
    """`CaptionLayout` ratios resolved to pixels for one canvas."""

    size: int
    gutter: int
    safe_bottom: int


@dataclass(frozen=True)
class CaptionTheme:
    """A resolved caption theme: palette + layout + font."""

    name: str
    palette: CaptionPalette
    layout: CaptionLayout
    font: str = ""

    def metrics(self, width: int, height: int, size_px: int = 0) -> CaptionMetrics:
        """Resolve ratios against a canvas. ``size_px`` forces an explicit size."""
        short = min(width, height)
        return CaptionMetrics(
            size=int(size_px) if size_px else int(round(short * self.layout.size)),
            gutter=int(round(short * self.layout.gutter)),
            safe_bottom=int(height * self.layout.safe_bottom),
        )


def resolve(settings) -> CaptionTheme:
    """Build the caption theme for a run: named preset + explicit overrides.

    ``--highlight-color`` overrides the preset's accent; everything else comes
    from the preset, so an override never silently drops the rest of the theme.
    """
    name = getattr(settings, "theme", "") or DEFAULT_THEME
    palette = PALETTES.get(name, PALETTES[DEFAULT_THEME])
    accent = getattr(settings, "highlight_color", "")
    if accent:
        palette = replace(palette, highlight=accent)
    return CaptionTheme(
        name=name,
        palette=palette,
        layout=CaptionLayout(),
        font=getattr(settings, "font", "") or "",
    )


# ---- Terminal ----------------------------------------------------------------

# One glyph per status level. Call sites pass a level, never a glyph, so a
# message can't end up double-marked.
STATUS_GLYPHS = {
    "step": "▶",
    "ok": "✓",
    "info": "•",
    "warn": "!",
    "err": "✗",
}
STATUS_DEFAULT = "•"
DEBUG_PREFIX = "  · "
STDERR_LEVELS = frozenset({"warn", "err"})
