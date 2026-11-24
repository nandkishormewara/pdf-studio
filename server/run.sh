#!/usr/bin/env bash
# Starts the PDF Studio server on http://127.0.0.1:8787 (creates the virtualenv on first run).
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements-dev.txt
fi
exec .venv/bin/uvicorn app.main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8787}" "$@"
