#!/usr/bin/env bash
# Deploys PDF Studio from this computer to a test server prepared with deploy/ubuntu/setup-server.sh.
#
#   deploy/deploy.sh ubuntu@pdf-studio.example.com            web app + server
#   deploy/deploy.sh ubuntu@pdf-studio.example.com --web-only
#
# Builds the web app here (the server needs no Node.js), copies web/dist and server/ with rsync over SSH,
# installs the Python requirements on the server, restarts the service and checks /pdf-api/health.
# Needs SSH access with sudo on the server. Nothing is deployed from uncommitted changes without a warning.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:?give user@host, e.g. ubuntu@pdf-studio.example.com}"; shift || true
web_only=0
for a in "$@"; do [ "$a" = --web-only ] && web_only=1; done
host="${target#*@}"
commit="$(git -C "$root" rev-parse --short HEAD)"
[ -z "$(git -C "$root" status --porcelain -- web server)" ] || echo "! web/ or server/ has uncommitted changes: they will be deployed too (version shown: $commit+)."

echo "→ Building the web app ($commit) for https://$host (server at /pdf-api)"
(cd "$root/web" && { [ -d node_modules ] || npm ci --no-audit --no-fund; } \
  && VITE_PDFSTUDIO_SERVER=/pdf-api npm run -s build)

echo "→ Copying the web app"
rsync -az --delete -e ssh "$root/web/dist/" "$target:/tmp/pdf-studio-web/"
ssh "$target" "sudo rsync -a --delete /tmp/pdf-studio-web/ /opt/pdf-studio/web/ && rm -rf /tmp/pdf-studio-web"

if [ "$web_only" = 0 ]; then
  echo "→ Copying the server"
  rsync -az --delete -e ssh --exclude .venv --exclude data --exclude tests --exclude __pycache__ --exclude .pytest_cache \
    "$root/server/" "$target:/tmp/pdf-studio-server/"
  ssh "$target" "set -e
    sudo rsync -a --delete --exclude .venv /tmp/pdf-studio-server/ /opt/pdf-studio/server/ && rm -rf /tmp/pdf-studio-server
    [ -d /opt/pdf-studio/server/.venv ] || sudo python3 -m venv /opt/pdf-studio/server/.venv
    sudo /opt/pdf-studio/server/.venv/bin/pip install -q -r /opt/pdf-studio/server/requirements.txt
    echo $commit | sudo tee /opt/pdf-studio/VERSION >/dev/null
    sudo systemctl restart pdf-studio-server"
fi

echo "→ Checking"
for _ in $(seq 1 30); do
  if health="$(ssh "$target" 'curl -fs http://127.0.0.1/pdf-api/health -H "Host: localhost"')"; then break; fi
  sleep 2
done
[ -n "${health:-}" ] || { echo "✗ /pdf-api/health did not answer. On the server: sudo journalctl -u pdf-studio-server -n 50" >&2; exit 1; }
echo "  health: $health" | cut -c1-220
echo "✓ Deployed $commit. Open http://$host (or https:// once certbot is set up)."
