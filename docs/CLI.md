# HookCut CLI reference

```
hookcut [inputs...] [options]
```

## Inputs
One or more files, folders, URLs, or `gdrive:`/`icloud:` specs (see README).

## Options

| Flag | Default | Description |
|---|---|---|
| `-d, --durations` | `30` | Any mix of `15 30 45 60 extended` |
| `-o, --out` | `hookcut_out` | Output folder |
| `--aspect` | `9:16` | `9:16` \| `1:1` \| `4:5` \| `16:9` |
| `--mode` | `auto` | `auto` \| `talking` \| `broll` \| `gameplay` \| `mixed` |
| `--whisper-model` | `base` | `tiny` \| `base` \| `small` \| `medium` \| `large-v3` |
| `--language` | auto | Force a language code (e.g. `en`) |
| `--device` | `auto` | `auto` \| `cpu` \| `cuda` |
| `--no-llm` | off | Heuristics only, no API calls |
| `--model` | `claude-sonnet-4-5` | Claude model id |
| `--caption-style` | `karaoke` | `karaoke` \| `block` \| `none` |
| `--theme` | `default` | Caption color theme: `default` \| `mono` |
| `--font` | auto | Path to a `.ttf` for captions |
| `--caption-size` | auto | Caption font size in px; default scales from the theme |
| `--highlight-color` | theme | Override the theme's karaoke accent (e.g. `#F5D90A`) |
| `--music` | — | Path to a music bed |
| `--beat-sync` | off | Snap cuts to music beats (needs librosa) |
| `--no-audit` | off | Skip the self-audit loop |
| `--audit-threshold` | `7.5` | Re-edit until a cut scores this |
| `--max-iterations` | `2` | Audit re-plan attempts |
| `--trends-file` | bundled | Path to a custom `trends.yaml` |
| `--refresh-trends` | off | Refresh trend notes from `--trends-file` (path/URL) |
| `--dry-run` | off | Plan + package, skip rendering |
| `-v, --verbose` | off | Verbose logs |

## Output

```
hookcut_out/
  <hook-slug>_30s_9x16.mp4     rendered edit
  30s_package.txt              hook overlay, caption, hashtags, audit notes
  manifest.json                every clip, timestamp, score, decision
  _ingest/                     anything downloaded from URLs/Drive/iCloud
```

Transcripts are cached as `<video>.hookcut.json` for instant re-runs.

## Feature dependency map

| Feature | Extra |
|---|---|
| Transcription | `faster-whisper` (core) |
| Smart hooks / captions / audit | `anthropic` + `ANTHROPIC_API_KEY` |
| Robust scene detection | `scenedetect` (else ffmpeg fallback) |
| URL ingest | `yt-dlp` |
| Google Drive links | `gdown`; folders/remotes → `rclone` |
| Beat sync | `librosa` |
| Trend refresh from URL | `requests` |

Install everything: `pip install -e ".[all]"`.

## Caption theme

Every visual value HookCut burns into a video — and every glyph it prints to
the terminal — is a token in [`hookcut/theme.py`](../hookcut/theme.py). Nothing
visual is authored anywhere else.

| Theme | Accent | Use |
|---|---|---|
| `default` | `#F5D90A` | The shipped look: yellow accent resolving to white |
| `mono` | `#9A9A9A` | No accent hue, for footage the yellow fights with |

Under karaoke timing a word is drawn in the **accent** until its moment
arrives, then switches to the **fill** — so the accent is the *pending* color
and white is the *spoken* one.

Sizes and gutters are stored as ratios of the canvas, not pixels: type and side
gutters scale off the short edge, the bottom safe area off height. All four
`--aspect` presets are 1080 on the short edge, so they render at the shipped
64px / 60px; a 4K canvas gets 128px / 120px instead of hairline text.

Add a theme by adding one `CaptionPalette` to `PALETTES` — `--theme` picks up
the new key automatically. `--highlight-color` overrides only the accent and
leaves the rest of the theme intact.
