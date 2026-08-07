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
| `--font` | auto | Path to a `.ttf` for captions |
| `--caption-size` | `64` | Caption font size |
| `--highlight-color` | `#F5D90A` | Karaoke highlight color |
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
