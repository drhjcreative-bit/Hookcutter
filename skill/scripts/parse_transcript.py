#!/usr/bin/env python3
"""Parse a transcript into normalized timestamped segments.

Supports:
  * SRT              (.srt)
  * WebVTT           (.vtt)
  * Whisper JSON     (OpenAI or faster-whisper style: {"segments":[{start,end,text,words}]})
  * HookCut cache    (<video>.hookcut.json)
  * Plain text with [mm:ss] or [h:mm:ss.ms] or (12.3) leading timestamps

Usage:
  python3 parse_transcript.py transcript.srt            # -> segments JSON on stdout
  python3 parse_transcript.py transcript.json --words   # include word timings if present

Output schema:
  {"duration": float|null,
   "segments": [{"start": s, "end": s, "text": str, "words": [{start,end,text}]}]}
"""
from __future__ import annotations

import argparse
import json
import re
import sys


def _ts_to_s(ts: str) -> float:
    ts = ts.strip().replace(",", ".")
    parts = ts.split(":")
    parts = [float(p) for p in parts]
    if len(parts) == 3:
        h, m, s = parts
    elif len(parts) == 2:
        h, m, s = 0.0, parts[0], parts[1]
    else:
        h, m, s = 0.0, 0.0, parts[0]
    return h * 3600 + m * 60 + s


def parse_srt_vtt(text: str) -> list:
    text = text.replace("\r\n", "\n")
    # strip WEBVTT header
    text = re.sub(r"^WEBVTT.*?\n\n", "", text, flags=re.S)
    blocks = re.split(r"\n\s*\n", text.strip())
    segs = []
    time_re = re.compile(r"([0-9:.,]+)\s*-->\s*([0-9:.,]+)")
    for b in blocks:
        m = time_re.search(b)
        if not m:
            continue
        start, end = _ts_to_s(m.group(1)), _ts_to_s(m.group(2))
        lines = [ln for ln in b.split("\n") if "-->" not in ln]
        # drop a numeric index line
        if lines and lines[0].strip().isdigit():
            lines = lines[1:]
        body = re.sub(r"<[^>]+>", "", " ".join(lines)).strip()
        if body:
            segs.append({"start": start, "end": end, "text": body, "words": []})
    return segs


def parse_whisper_json(data: dict, want_words: bool) -> tuple:
    segs = []
    for s in data.get("segments", []):
        words = []
        if want_words:
            for w in s.get("words", []) or []:
                words.append({
                    "start": float(w.get("start", s.get("start", 0))),
                    "end": float(w.get("end", s.get("end", 0))),
                    "text": str(w.get("word", w.get("text", ""))).strip(),
                })
        segs.append({
            "start": float(s.get("start", 0)),
            "end": float(s.get("end", 0)),
            "text": str(s.get("text", "")).strip(),
            "words": words,
        })
    dur = data.get("duration")
    return segs, (float(dur) if dur is not None else (segs[-1]["end"] if segs else None))


def parse_plain(text: str) -> list:
    segs = []
    pat = re.compile(r"^\s*[\[(]?\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?(?:[.,][0-9]+)?)\s*[\])]?\s*(.*)$")
    last = None
    for line in text.split("\n"):
        m = pat.match(line)
        if m:
            t = _ts_to_s(m.group(1))
            body = m.group(2).strip()
            if last is not None:
                last["end"] = t
            last = {"start": t, "end": t + 3.0, "text": body, "words": []}
            segs.append(last)
        elif last is not None and line.strip():
            last["text"] = (last["text"] + " " + line.strip()).strip()
    return segs


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--words", action="store_true", help="include word timings if present")
    a = ap.parse_args(argv)

    with open(a.path, encoding="utf-8", errors="replace") as fh:
        raw = fh.read()

    duration = None
    lower = a.path.lower()
    if lower.endswith(".json") or raw.lstrip().startswith("{"):
        try:
            data = json.loads(raw)
            segs, duration = parse_whisper_json(data, a.words)
        except Exception:
            segs = parse_plain(raw)
    elif lower.endswith((".srt", ".vtt")) or "-->" in raw:
        segs = parse_srt_vtt(raw)
    else:
        segs = parse_plain(raw)

    if segs and duration is None:
        duration = segs[-1]["end"]

    json.dump({"duration": duration, "segments": segs}, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
