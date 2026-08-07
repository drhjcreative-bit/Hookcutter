"""Configuration objects and duration presets for HookCut."""
from __future__ import annotations

import os
from dataclasses import dataclass, field, asdict
from typing import Optional

# ---- Duration presets --------------------------------------------------------
# Each preset is a *target* length. The planner tries to land within tolerance.
DURATION_PRESETS = {
    "15": 15.0,
    "30": 30.0,
    "45": 45.0,
    "60": 60.0,
    # "extended" is resolved at plan-time to the strongest 90-180s cut.
    "extended": 150.0,
}

# Platform aspect ratios (width:height).
ASPECTS = {
    "9:16": (1080, 1920),   # Reels / TikTok / Shorts
    "1:1": (1080, 1080),    # feed square
    "4:5": (1080, 1350),    # feed portrait
    "16:9": (1920, 1080),   # landscape / YouTube
}

# Footage modes drive how hooks are found.
FOOTAGE_MODES = ("auto", "talking", "broll", "gameplay", "mixed")


@dataclass
class Settings:
    # I/O
    inputs: list = field(default_factory=list)          # files or folders
    out_dir: str = "hookcut_out"
    durations: list = field(default_factory=lambda: ["30"])
    aspect: str = "9:16"
    mode: str = "auto"                                   # footage mode

    # transcription
    whisper_model: str = "base"                          # tiny/base/small/medium/large-v3
    language: Optional[str] = None                       # None = autodetect
    device: str = "auto"                                 # auto/cpu/cuda
    compute_type: str = "auto"

    # hook detection / brains
    use_llm: bool = True                                 # use Claude when key present
    model: str = "claude-sonnet-4-5"                     # override via --model or env
    max_hooks: int = 12
    min_clip: float = 0.6                                # min sub-clip length (s)

    # captions
    captions: bool = True
    caption_style: str = "karaoke"                       # karaoke/block/none
    font: str = ""                                       # path to .ttf; "" = auto
    caption_size: int = 64
    highlight_color: str = "#F5D90A"

    # music / rhythm
    music: str = ""                                      # path to a music bed
    music_db: float = -18.0                              # music level under voice
    beat_sync: bool = False

    # audit loop
    audit: bool = True
    audit_threshold: float = 7.5                         # 0-10; re-plan below this
    max_iterations: int = 2

    # trends
    trends_file: str = ""                                # "" = bundled trends.yaml
    refresh_trends: bool = False                         # fetch latest before run

    # runtime
    dry_run: bool = False                                # plan only, no render
    jobs: int = 1
    verbose: bool = False
    seed: int = 7

    def api_key(self) -> Optional[str]:
        return os.environ.get("ANTHROPIC_API_KEY")

    def llm_enabled(self) -> bool:
        return bool(self.use_llm and self.api_key())

    def as_dict(self) -> dict:
        return asdict(self)
