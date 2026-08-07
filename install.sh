#!/usr/bin/env bash
# HookCut installer — sets up a virtualenv and installs everything.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

echo "▶ HookCut installer"

# 1. ffmpeg check
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "! ffmpeg not found."
  if [[ "$(uname)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    echo "  Installing ffmpeg via Homebrew…"
    brew install ffmpeg
  else
    echo "  Please install ffmpeg first:"
    echo "    macOS:  brew install ffmpeg"
    echo "    Debian: sudo apt update && sudo apt install -y ffmpeg"
    exit 1
  fi
fi
echo "✓ ffmpeg present"

# 2. venv
PYBIN="${PYTHON:-python3}"
if [[ ! -d .venv ]]; then
  echo "▶ creating virtualenv (.venv)…"
  "$PYBIN" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip >/dev/null

# 3. install package + all extras
echo "▶ installing HookCut + dependencies (this pulls Whisper models on first run)…"
pip install -e ".[all]"

echo
echo "✓ Done. Activate with:  source .venv/bin/activate"
echo "  Then set your key:     export ANTHROPIC_API_KEY=sk-ant-..."
echo "  Try it:                hookcut ~/Desktop/yourclip.mov -d 15 30 60"
echo
echo "  (No API key? It still runs on heuristics — just add the key for smarter hooks.)"
