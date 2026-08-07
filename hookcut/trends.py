"""Trend library loader + format selection + caption/hashtag/title generation.

The library is a human-editable YAML (bundled trends.yaml). At runtime we:
  - pick the best-fit format for the footage mode and target length,
  - ask the LLM (if available) to write a scroll-stopping caption, title and
    hashtags grounded in the chosen format + the actual hook line,
  - fall back to template-based copy when offline.

`refresh(url_or_path)` best-effort appends notes from a source you control
(a saved trends doc, a URL). It never fabricates trend data.
"""
from __future__ import annotations

import os
from typing import Optional

from . import llm
from .segments import CutPlan
from .utils import log, debug

_BUNDLED = os.path.join(os.path.dirname(__file__), "trends.yaml")


def _load_yaml(path: str) -> dict:
    try:
        import yaml
    except ImportError:
        log("pyyaml not installed — trend copy will use built-in defaults", level="warn")
        return {}
    try:
        with open(path) as fh:
            return yaml.safe_load(fh) or {}
    except Exception as e:
        debug(f"trend load failed: {e}")
        return {}


class Trends:
    def __init__(self, settings):
        path = settings.trends_file or _BUNDLED
        self.data = _load_yaml(path)
        self.settings = settings

    # ---- format selection ---------------------------------------------------
    def pick_format(self, mode: str, duration_key: str) -> dict:
        formats = self.data.get("formats", [])
        best = None
        for f in formats:
            fits = f.get("fits", [])
            lengths = [str(x) for x in f.get("lengths", [])]
            if (mode in fits or "mixed" in fits) and (duration_key in lengths or not lengths):
                best = f
                break
        if best is None and formats:
            best = formats[0]
        return best or {"id": "talking_fast_cut", "label": "Fast-cut",
                        "caption": "karaoke", "pacing": ""}

    def principles(self) -> list:
        return self.data.get("principles", [])

    # ---- copy generation ----------------------------------------------------
    def write_copy(self, plan: CutPlan, mode: str, topic: str = "") -> None:
        fmt = self.pick_format(mode, plan.duration_key)
        plan.trend_format = fmt.get("label", fmt.get("id", ""))

        if llm.available(self.settings):
            body = " ".join(c.text for c in plan.clips if c.text)[:2000]
            prompt = (
                f"You are packaging a {plan.duration_key}s short-form video.\n"
                f"Format: {fmt.get('label')} — {fmt.get('pacing','')}\n"
                f"Hook moment (verbatim): {plan.hook_line!r}\n"
                f"Transcript of the edit: {body!r}\n\n"
                "Write platform-ready packaging. Respond ONLY as JSON with keys:\n"
                '  "title": a 3-6 word on-screen hook overlay (punchy, no hashtags),\n'
                '  "caption": a 1-2 sentence post caption that opens a curiosity gap,\n'
                '  "hashtags": 5-8 relevant hashtags as an array (mix niche + broad).\n'
            )
            data = llm.ask(prompt, self.settings, as_json=True, max_tokens=500, temperature=0.6)
            if isinstance(data, dict):
                plan.title = str(data.get("title", "")).strip()
                plan.caption_full = str(data.get("caption", "")).strip()
                hts = data.get("hashtags", [])
                if isinstance(hts, list):
                    plan.hashtags = [str(h).strip() for h in hts if str(h).strip()]
        if not plan.title:
            plan.title = (plan.hook_line[:48] or "Watch this").strip()
        if not plan.caption_full:
            plan.caption_full = plan.hook_line.strip()
        if not plan.hashtags:
            seed = self.data.get("hashtags_seed", {}).get("general", ["#fyp", "#shorts", "#viral"])
            plan.hashtags = list(seed)


def refresh(url_or_path: str, settings) -> Optional[str]:
    """Best-effort refresh of the trend notes from a source you control.

    Accepts a local file (merged in) or a URL (fetched with requests if the
    library is installed). Returns the path written, or None.
    """
    text = ""
    try:
        if os.path.exists(os.path.expanduser(url_or_path)):
            with open(os.path.expanduser(url_or_path)) as fh:
                text = fh.read()
        elif url_or_path.startswith("http"):
            import requests
            text = requests.get(url_or_path, timeout=20).text
    except Exception as e:
        log(f"trend refresh failed: {e}", level="warn")
        return None
    if not text.strip():
        return None
    dest = settings.trends_file or _BUNDLED
    note_path = os.path.splitext(dest)[0] + ".refresh.txt"
    with open(note_path, "w") as fh:
        fh.write(text)
    log(f"trend notes refreshed → {note_path}", level="ok")
    return note_path
