"""Resolve input specs into local video files.

Supported input forms (any mix, positional):
  * A local file:            /path/to/clip.mov
  * A local folder:          ~/Desktop/footage        (recursed for video files)
  * iCloud Drive:            icloud:Footage/raw.mp4    or  icloud:            (whole drive)
  * Google Drive (rclone):   gdrive:Footage/raw.mp4    (needs an rclone remote named 'gdrive')
  * Google Drive (link/id):  https://drive.google.com/file/d/<ID>/view   (needs gdown)
  * Any web / social URL:    https://youtube.com/...   or  https://www.tiktok.com/...  (needs yt-dlp)

Everything is copied/downloaded into <out_dir>/_ingest so the rest of the
pipeline only ever touches local files.

Notes on the ecosystems you asked about:
  - Desktop / Files: just pass the path. On macOS "~/Desktop" and "~/Documents"
    work out of the box.
  - iCloud Drive: on macOS it is a normal folder at
    ~/Library/Mobile Documents/com~apple~CloudDocs — we resolve "icloud:" to it
    and trigger download of any evicted (cloud-only) files via `brctl download`.
  - Google Drive: the robust path is rclone (`rclone config` → remote 'gdrive').
    Public share links also work via `gdown`.
  - Browsers: any page/video URL is handed to yt-dlp, which supports YouTube,
    TikTok, Instagram, X, Vimeo, and 1000+ sites.
"""
from __future__ import annotations

import os
import re
import glob
import shutil
from typing import List

from .utils import VIDEO_EXTS, log, debug, run, which, ensure_dir

ICLOUD_ROOT = os.path.expanduser("~/Library/Mobile Documents/com~apple~CloudDocs")
URL_RE = re.compile(r"^https?://", re.I)


def _is_video(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in VIDEO_EXTS


def _collect_folder(folder: str) -> List[str]:
    out = []
    for root, _dirs, files in os.walk(folder):
        for f in sorted(files):
            if _is_video(f) and not f.startswith("._"):
                out.append(os.path.join(root, f))
    return out


def _icloud_download(path: str) -> None:
    """Ask macOS to materialize a cloud-only file, best effort."""
    if which("brctl"):
        try:
            run(["brctl", "download", path], check=False)
        except Exception:
            pass


def _resolve_icloud(spec: str, ingest: str) -> List[str]:
    rel = spec[len("icloud:"):].lstrip("/")
    base = os.path.join(ICLOUD_ROOT, rel) if rel else ICLOUD_ROOT
    if not os.path.exists(ICLOUD_ROOT):
        log("iCloud Drive folder not found (are you on macOS with iCloud enabled?)", level="warn")
        return []
    _icloud_download(base)
    if os.path.isdir(base):
        return _collect_folder(base)
    if os.path.isfile(base):
        return [base]
    log(f"iCloud path not found: {rel}", level="warn")
    return []


def _resolve_rclone(spec: str, ingest: str) -> List[str]:
    if not which("rclone"):
        log("rclone not installed — run `brew install rclone && rclone config`", level="warn")
        return []
    remote = spec  # e.g. gdrive:Footage/clip.mp4  or  gdrive:Footage
    dest = ensure_dir(os.path.join(ingest, "gdrive"))
    # copy works for both a single file and a folder
    run(["rclone", "copy", "--progress", remote, dest], check=False)
    return _collect_folder(dest)


def _resolve_gdown(url: str, ingest: str) -> List[str]:
    if not which("gdown"):
        log("gdown not installed — run `pip install gdown` for Drive share links", level="warn")
        return []
    dest = ensure_dir(os.path.join(ingest, "gdrive"))
    run(["gdown", "--fuzzy", "-O", dest + os.sep, url], check=False)
    return _collect_folder(dest)


def _resolve_url(url: str, ingest: str) -> List[str]:
    if not which("yt-dlp"):
        log("yt-dlp not installed — run `pip install yt-dlp` to pull from URLs", level="warn")
        return []
    dest = ensure_dir(os.path.join(ingest, "web"))
    out_tmpl = os.path.join(dest, "%(title).80s-%(id)s.%(ext)s")
    run([
        "yt-dlp", "-f", "bv*+ba/b", "--merge-output-format", "mp4",
        "-o", out_tmpl, url,
    ], check=False)
    return _collect_folder(dest)


def resolve_inputs(specs: List[str], out_dir: str) -> List[str]:
    """Turn a list of input specs into a de-duplicated list of local video files."""
    ingest = ensure_dir(os.path.join(out_dir, "_ingest"))
    found: List[str] = []

    for spec in specs:
        s = spec.strip()
        if not s:
            continue
        if s.startswith("icloud:"):
            found += _resolve_icloud(s, ingest)
        elif re.match(r"^[A-Za-z0-9_\-]+:", s) and not URL_RE.match(s) and ":" in s and "/" not in s.split(":", 1)[0]:
            # looks like an rclone remote spec  remote:path
            found += _resolve_rclone(s, ingest)
        elif URL_RE.match(s) and "drive.google.com" in s:
            found += _resolve_gdown(s, ingest)
        elif URL_RE.match(s):
            found += _resolve_url(s, ingest)
        else:
            p = os.path.expanduser(s)
            matches = glob.glob(p)
            if not matches and os.path.exists(p):
                matches = [p]
            for m in matches:
                if os.path.isdir(m):
                    found += _collect_folder(m)
                elif os.path.isfile(m) and _is_video(m):
                    found.append(m)
                elif os.path.isfile(m):
                    debug(f"skipping non-video file: {m}")
            if not matches:
                log(f"no match for input: {s}", level="warn")

    # de-dup, keep order
    seen = set()
    uniq = []
    for f in found:
        real = os.path.realpath(f)
        if real not in seen:
            seen.add(real)
            uniq.append(f)
    return uniq
