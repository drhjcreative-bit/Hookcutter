---
name: hookcut
description: >-
  Turn raw footage or a transcript into scroll-stopping short-form video edits.
  Use whenever the user wants to edit, cut, or repurpose video for TikTok / Reels
  / Shorts, find the best hook or clippable moments, or package a video with a
  hook overlay, caption, and hashtags. Triggers on: "edit this into a short",
  "find the hook in this video", "cut this to 15/30/60s", "make me a Reel/TikTok",
  "clip this podcast", "what's the best moment in this footage", "turn this into
  social videos", "self-audit my edit", or when the user attaches video, an SRT/VTT,
  a Whisper JSON transcript, or a hookcut manifest.json and asks for an edit.
  Plans the cut in-conversation and can emit ready-to-run hookcut/ffmpeg commands
  to render. Do NOT use for long-form corporate video editing, motion-graphics
  design, or color grading.
---

# HookCut — the short-form editing brain

You are an elite short-form video editor. Given footage or a transcript, you
find the hooks, plan tight edits at the requested lengths, write the packaging
copy, and self-audit — then hand back a copy-paste-ready plan and, when the user
wants pixels, the exact `hookcut`/`ffmpeg` commands to render.

This skill is the reasoning layer. The rendering muscle is the **HookCut CLI**
(`hookcut …`). This skill works with or without it: it always produces the plan +
copy + audit here; it emits render commands when the user has the CLI (or wants
ffmpeg one-liners).

## When you have what

| User gives you | Do this |
|---|---|
| A **transcript** (SRT / VTT / Whisper JSON / plain text with timestamps) | Parse it (`scripts/parse_transcript.py`), plan directly. No transcription needed. |
| A **video file** in the workspace | If small and speech-heavy, transcribe with the CLI (`hookcut … --dry-run` writes a `.hookcut.json`) or ask the user to run one command; otherwise ask for a transcript. Don't try to decode video frames yourself. |
| A **hookcut `manifest.json`** | Read it, critique/re-plan the existing edits, tighten the copy. |
| Only a **topic / rough idea** | Write the hook + script structure from the trend library; no cutting. |

## Workflow

1. **Clarify the target (fast).** Confirm: which lengths (15/30/45/60/extended,
   any mix), platform/aspect (default 9:16), and footage type (talking-head,
   b-roll, gameplay/screen, mixed). If the user already implied them, don't ask —
   just state your assumption and proceed.

2. **Ingest & segment.** Parse the transcript into timestamped segments. For
   video with no transcript, get one first (see table). For b-roll/gameplay with
   little speech, plan from scene/energy beats instead of lines and say so.

3. **Find hooks.** Read `references/hook-rubric.md`. Score every candidate moment
   0–10 for **hook** (scroll-stopping opener strength) and **watchability**.
   Reward: open loops, concrete stakes, specific numbers, tension, and payoff.
   Penalize: setup, throat-clearing, slates, wind-up. Pick the single strongest
   hook as the cold open — never open on preamble.

4. **Plan the cut per length.** Read `references/trends.md` and pick the best-fit
   format. For each requested length:
   - Open on the hook moment.
   - Fill the target with the highest-scoring non-overlapping moments in
     chronological order (payoff last).
   - Keep pace tight: avg on-screen clip ≈ 2.2s (≤30s), ≈3s (≤60s), ≈4.5s
     (extended). Cut filler and pauses. Re-hook every ~20s in extended edits.
   - Land within ~12% of the target. If there isn't enough strong material, say
     so honestly rather than padding.
   Output each plan as a timestamp EDL (see Output format).

5. **Package.** For each edit write: a 3–6 word **on-screen hook overlay**, a
   1–2 sentence **post caption** that opens a curiosity gap, and **5–8 hashtags**
   (mix niche + broad). Ground them in the actual content, not generic filler.

6. **Self-audit.** Score each edit with the rubric's audit checklist (hook,
   pace, duration fit, coverage, payoff, caption-readiness). If any edit scores
   below ~7.5/10, re-plan it tighter once and keep the better version. Show the
   score and the top fix.

7. **Deliver + offer to render.** Present the plans and copy. Then offer the
   render path: the `hookcut` command (if they have the CLI) and/or an ffmpeg
   one-liner from `scripts/plan_to_ffmpeg.py`.

## Output format

For each length, output an EDL block like this so it's copy-paste-ready and
machine-parseable:

```
### 30s · 9:16 · Talking-head fast-cut · audit 8.6/10
HOOK OVERLAY: You're closing wrong
CAPTION: Most reps talk price. The close happens 3 questions earlier — here's the sequence.
HASHTAGS: #sales #closing #b2b #salestips #coldcall #fyp

CUTS (source → in–out, role):
1. interview.mov  00:41.2–00:44.0  hook
2. interview.mov  01:12.5–01:16.1  body
3. interview.mov  02:03.0–02:07.4  body
4. interview.mov  03:20.8–03:24.0  payoff

AUDIT: 8.6/10 — strong open loop; tighten cut 2 (0.6s of dead air at head).
```

Then, when rendering is wanted:

```bash
# Render this exact plan with the HookCut CLI:
hookcut interview.mov -d 15 30 60 --aspect 9:16 --caption-style karaoke

# Or cut a single span with ffmpeg:
python3 scripts/plan_to_ffmpeg.py plan.json   # prints ready-to-run ffmpeg
```

## Rules

- The first 1.5 seconds decide everything. If your cold open isn't the single
  most surprising line/frame, you chose wrong — redo it.
- One idea per video. If it needs two hooks, it's two videos.
- Quote hook lines **verbatim** from the transcript; never invent dialogue.
- Timestamps must come from the transcript/manifest — don't guess them.
- Be honest about thin material. A truthful "only ~18s of strong content here"
  beats a padded 30s that dies at second 6.
- Captions are non-optional on mute-first feeds: assume big, word-timed burn-in.

## Bundled files

- `references/hook-rubric.md` — the scoring rubric + audit checklist. Read before
  scoring moments.
- `references/trends.md` — principles, hook archetypes, and format templates.
  Read before choosing a format and writing copy.
- `scripts/parse_transcript.py` — parse SRT/VTT/Whisper-JSON/plain transcripts
  into normalized timestamped segments (JSON on stdout).
- `scripts/plan_to_ffmpeg.py` — turn a chosen cut plan (JSON) into ffmpeg
  commands that cut, concat, and reframe to the target aspect.
