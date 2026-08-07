# HookCut Video Engine 🎬

An automated social-media video editor in two parts that work together:

- **`hookcut/` — the CLI (the muscle).** Point it at footage and it transcribes,
  finds hooks, cuts 15/30/45/60s + extended edits, reframes to 9:16/1:1/4:5/16:9,
  burns in karaoke captions, packages the copy, and self-audits — all locally
  with ffmpeg + Whisper.
- **`skill/` — the Claude / Cowork skill (the brain).** Runs inside Claude:
  attach footage, a transcript, or the CLI's `manifest.json` and it plans the
  cut, writes the hook/caption/hashtags, self-audits, and emits ready-to-run
  render commands.

The CLI works standalone. The skill works standalone. Together, the skill plans
and the CLI renders.

---

## Quick start (CLI)

```bash
git clone https://github.com/drhjcreative-bit/Hookcutter.git
cd Hookcutter
./install.sh                       # creates .venv, installs everything
source .venv/bin/activate
export ANTHROPIC_API_KEY=sk-ant-...   # optional; smarter hooks/captions/audit

hookcut ~/Desktop/interview.mov -d 15 30 60
```

Requires **ffmpeg** on PATH (`brew install ffmpeg` / `apt install ffmpeg`).
Without an API key it still runs fully on heuristics.

### Input sources (mix freely)

| Spec | Needs |
|---|---|
| `path/to/clip.mov`, `~/Desktop/folder` | nothing |
| `icloud:Path/clip.mp4` | macOS + iCloud Drive |
| `gdrive:Path/clip.mp4` | `rclone config` → remote `gdrive` |
| `https://drive.google.com/…` | `gdown` |
| `https://youtube.com/…`, TikTok, IG, X | `yt-dlp` |

### Common options

```
-d, --durations 15 30 45 60 extended      --aspect 9:16|1:1|4:5|16:9
--mode auto|talking|broll|gameplay|mixed  --whisper-model tiny…large-v3
--caption-style karaoke|block|none        --music FILE  --beat-sync
--audit-threshold 7.5  --max-iterations 2 --no-llm  --dry-run  -v
```

Full docs: [`docs/CLI.md`](docs/CLI.md). Run `hookcut --help` for everything.

---

## Quick start (Skill)

The skill lives in [`skill/`](skill/). To use it in Claude / Cowork, zip its
contents into a `.skill` file and add it to your skills:

```bash
cd skill && zip -r ../hookcut.skill . -x '*/__pycache__/*' && cd ..
# then upload hookcut.skill in Claude (Cowork → Skills)
```

Then, with footage or a transcript attached, say:
*"find the hook and cut this to 15/30/60."*

The skill reads its rubric (`skill/references/hook-rubric.md`) and trend library
(`skill/references/trends.md`), plans the edit, and can call its helper scripts:

```bash
python3 skill/scripts/parse_transcript.py transcript.srt   # → normalized JSON
python3 skill/scripts/plan_to_ffmpeg.py plan.json --run     # → rendered mp4
```

---

## How it works

1. **Ingest** — local/iCloud/Drive/URL → local files.
2. **Transcribe** — faster-whisper, word-level timestamps, cached per source.
3. **Analyze** — scene cuts (PySceneDetect/ffmpeg) + audio-energy peaks for
   b-roll/gameplay.
4. **Find hooks** — Claude scores the transcript for open loops/stakes/payoff,
   blended with heuristics (curiosity markers, questions, numbers, energy,
   position). Non-dialogue footage uses scene/peak moments.
5. **Plan** — open on the strongest hook, fill the target chronologically,
   payoff last, trim to length, optional beat-snap.
6. **Render** — cut, reframe, concat, karaoke captions, ducked music bed.
7. **Package** — title/hook overlay, caption, hashtags from the trend library.
8. **Self-audit** — score hook/pace/duration/coverage/captions and re-edit
   tighter below threshold.

Per edit you get an `.mp4`, a `…_package.txt` (copy + audit), and a
`manifest.json` describing every decision.

---

## Repo layout

```
hookcut/            the CLI package (installable: pip install .)
skill/              the Cowork/Claude skill (SKILL.md + references + scripts)
examples/           sample transcript + sample plan.json
docs/               extended CLI reference
install.sh          one-shot venv + deps
pyproject.toml      package + entry point (hookcut = hookcut.cli:main)
```

Every stage (`hooks.py`, `planner.py`, `render.py`, `audit.py`, `trends.py`) is
independent and swappable. Fork freely.

## License

MIT © 2026 Duane. See [LICENSE](LICENSE).
