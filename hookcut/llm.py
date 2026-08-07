"""Thin Claude API wrapper used by hook detection, captions, and audit.

Always optional: if the anthropic SDK or ANTHROPIC_API_KEY is missing, callers
fall back to heuristics. Returns parsed JSON when `as_json=True`.
"""
from __future__ import annotations

import json
import os
import re
from typing import Optional

from .utils import debug, log

_CLIENT = None


def available(settings) -> bool:
    return settings.llm_enabled()


def _client():
    global _CLIENT
    if _CLIENT is None:
        from anthropic import Anthropic
        _CLIENT = Anthropic()
    return _CLIENT


def _extract_json(text: str):
    text = text.strip()
    # strip code fences
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    # find first { or [
    for opener, closer in (("{", "}"), ("[", "]")):
        i = text.find(opener)
        if i != -1:
            depth = 0
            for j in range(i, len(text)):
                if text[j] == opener:
                    depth += 1
                elif text[j] == closer:
                    depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(text[i:j + 1])
                        except Exception:
                            break
    return json.loads(text)  # last resort, will raise


def ask(prompt: str, settings, *, system: str = "", as_json: bool = False,
        max_tokens: int = 2000, temperature: float = 0.3):
    if not available(settings):
        return None
    try:
        client = _client()
        msg = client.messages.create(
            model=settings.model,
            max_tokens=max_tokens,
            temperature=temperature,
            system=system or "You are a world-class short-form video editor and hook writer.",
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        if as_json:
            try:
                return _extract_json(text)
            except Exception as e:
                debug(f"LLM json parse failed: {e}")
                return None
        return text
    except Exception as e:
        log(f"LLM call failed ({e}); falling back to heuristics", level="warn")
        return None
