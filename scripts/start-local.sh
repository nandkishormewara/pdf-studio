#!/usr/bin/env bash
# Starts PDF Studio on this computer for testing: the processing server and the web app together.
#
#   scripts/start-local.sh            web app in development mode (live reload)  → http://localhost:5173
#   scripts/start-local.sh --built    production build served locally          → http://localhost:4173
#   scripts/start-local.sh --web-only without the server (Tools menu and Office files disabled)
#
# Needs Node.js 22+ and Python 3.12+. For OCR and Office files: brew install tesseract tesseract-lang
# and brew install --cask libreoffice (see docs/server-and-deployment.md). Ctrl-C stops everything.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
built=0; server=1
for a in "$@"; do
  case "$a" in
    --built) built=1 ;;
    --web-only) server=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option $a (see --help)" >&2; exit 1 ;;
  esac
done

# Stop early if a port is taken (usually PDF Studio already running in another terminal or app).
web_port=5173; [ "$built" = 1 ] && web_port=4173
busy=""
for port in $web_port $([ "$server" = 1 ] && echo 8787); do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    busy="$busy $port"
    echo "✗ Port $port is already in use by: $(lsof -nP -iTCP:"$port" -sTCP:LISTEN | awk 'NR==2 {print $1" (pid "$2")"}')" >&2
  fi
done
if [ -n "$busy" ]; then
  echo "  PDF Studio may already be running: try http://localhost:$web_port in your browser." >&2
  echo "  To stop what holds the port(s):  kill \$(lsof -t -iTCP:${busy# } -sTCP:LISTEN)" >&2
  exit 1
fi

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

if [ "$server" = 1 ]; then
  echo "→ Server on http://127.0.0.1:8787 (first run creates server/.venv)"
  # the web app's dev and preview ports must be allowed by CORS
  PDFSTUDIO_ALLOWED_ORIGINS="http://localhost:5173,http://localhost:4173,http://127.0.0.1:5173,http://127.0.0.1:4173" \
    "$root/server/run.sh" &
  pids+=($!)
fi

cd "$root/web"
[ -d node_modules ] || npm install --no-audit --no-fund
if [ "$built" = 1 ]; then
  npm run build
  echo "→ Web app (production build) on http://localhost:4173"
  npx vite preview --port 4173 --strictPort &
else
  echo "→ Web app on http://localhost:5173"
  npx vite --port 5173 --strictPort &
fi
pids+=($!)

if [ "$server" = 1 ]; then
  for _ in $(seq 1 60); do curl -fs http://127.0.0.1:8787/health >/dev/null 2>&1 && break; sleep 1; done
  curl -fs http://127.0.0.1:8787/health >/dev/null 2>&1 && echo "✓ Server is up (Tools menu shows a green dot)" || echo "! Server not answering yet: see the output above"
fi
echo "Ctrl-C to stop."
wait
