#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

if [ -d ".venv" ]; then
  source .venv/bin/activate
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "Python was not found. Please install Python 3 first."
  exit 1
fi

echo "Starting YouTubeTTS server on http://127.0.0.1:8000"
"$PYTHON_BIN" server.py
