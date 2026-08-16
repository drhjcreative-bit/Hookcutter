"""HookCut command-line interface."""
from __future__ import annotations

import argparse
import sys

from . import __version__
from .config import Settings, DURATION_PRESETS, ASPECTS, FOOTAGE_MODES
from .theme import PALETTES, DEFAULT_THEME
from .utils import log


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="hookcut",
        description="Automated social-media video editor: finds hooks, transcribes, "
                    "cuts 15/30/45/60s + extended edits, captions, and self-audits.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "INPUT SOURCES (mix freely):\n"
            "  path/to/clip.mov            local file\n"
            "  ~/Desktop/footage           folder (recursed)\n"
            "  icloud:Footage/raw.mp4      iCloud Drive (macOS)\n"
            "  gdrive:Footage/raw.mp4      Google Drive via rclone remote 'gdrive'\n"
            "  https://drive.google.com/…  Drive share link (needs gdown)\n"
            "  https://youtube.com/…       any web/social URL (needs yt-dlp)\n\n"
            "EXAMPLES:\n"
            "  hookcut ~/Desktop/raw.mov -d 15 30 60\n"
            "  hookcut icloud:Clips -d extended --aspect 9:16 --music bed.mp3 --beat-sync\n"
            "  hookcut https://youtu.be/xyz -d 30 --mode talking --dry-run\n"
        ),
    )
    p.add_argument("inputs", nargs="*", help="video files, folders, URLs, gdrive:/icloud: specs")
    p.add_argument("-d", "--durations", nargs="+", default=["30"],
                   metavar="LEN", help=f"target lengths: {', '.join(DURATION_PRESETS)} (default 30)")
    p.add_argument("-o", "--out", dest="out_dir", default="hookcut_out", help="output folder")
    p.add_argument("--aspect", default="9:16", choices=list(ASPECTS), help="output aspect ratio")
    p.add_argument("--mode", default="auto", choices=list(FOOTAGE_MODES),
                   help="footage type (auto-detects by default)")

    g = p.add_argument_group("transcription")
    g.add_argument("--whisper-model", default="base",
                   help="tiny/base/small/medium/large-v3 (default base)")
    g.add_argument("--language", default=None, help="force language (e.g. en); default autodetect")
    g.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])

    g = p.add_argument_group("brains")
    g.add_argument("--no-llm", action="store_true", help="disable Claude; heuristics only")
    g.add_argument("--model", default="claude-sonnet-4-5", help="Claude model id")
    g.add_argument("--max-hooks", type=int, default=12)

    g = p.add_argument_group("captions & music")
    g.add_argument("--no-captions", action="store_true")
    g.add_argument("--caption-style", default="karaoke", choices=["karaoke", "block", "none"])
    g.add_argument("--theme", default=DEFAULT_THEME, choices=list(PALETTES),
                   help=f"caption color theme (default {DEFAULT_THEME})")
    g.add_argument("--font", default="", help="path to a .ttf for captions")
    g.add_argument("--caption-size", type=int, default=0,
                   help="caption font size in px (default: scaled from the theme)")
    g.add_argument("--highlight-color", default="",
                   help="override the theme's karaoke accent "
                        f"(default theme uses {PALETTES[DEFAULT_THEME].highlight})")
    g.add_argument("--music", default="", help="path to a music bed")
    g.add_argument("--beat-sync", action="store_true", help="snap cuts to music beats (needs librosa)")

    g = p.add_argument_group("audit & trends")
    g.add_argument("--no-audit", action="store_true")
    g.add_argument("--audit-threshold", type=float, default=7.5)
    g.add_argument("--max-iterations", type=int, default=2)
    g.add_argument("--trends-file", default="", help="path to a custom trends.yaml")
    g.add_argument("--refresh-trends", action="store_true",
                   help="refresh trend notes from --trends-file (path or URL) first")

    g = p.add_argument_group("runtime")
    g.add_argument("--dry-run", action="store_true", help="plan + package, no rendering")
    g.add_argument("-v", "--verbose", action="store_true")
    g.add_argument("--version", action="version", version=f"HookCut {__version__}")
    return p


def settings_from_args(a: argparse.Namespace) -> Settings:
    return Settings(
        inputs=a.inputs, out_dir=a.out_dir, durations=a.durations, aspect=a.aspect,
        mode=a.mode, whisper_model=a.whisper_model, language=a.language, device=a.device,
        use_llm=not a.no_llm, model=a.model, max_hooks=a.max_hooks,
        captions=not a.no_captions, caption_style=a.caption_style,
        theme=a.theme, font=a.font,
        caption_size=a.caption_size, highlight_color=a.highlight_color,
        music=a.music, beat_sync=a.beat_sync,
        audit=not a.no_audit, audit_threshold=a.audit_threshold,
        max_iterations=a.max_iterations, trends_file=a.trends_file,
        refresh_trends=a.refresh_trends, dry_run=a.dry_run, verbose=a.verbose,
    )


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.inputs:
        parser.print_help()
        return 1
    settings = settings_from_args(args)

    if settings.use_llm and not settings.api_key():
        log("ANTHROPIC_API_KEY not set — running with heuristics only "
            "(hooks/captions/audit still work, just less smart).", level="warn")

    # import late so --help works without heavy deps installed
    from .pipeline import run
    try:
        result = run(settings)
    except KeyboardInterrupt:
        log("interrupted", level="warn")
        return 130
    except Exception as e:
        log(f"fatal: {e}", level="err")
        if settings.verbose:
            raise
        return 1
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    sys.exit(main())
