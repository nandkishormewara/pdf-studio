#!/usr/bin/env bash
# One-time setup of a test server for PDF Studio. Run as root on Ubuntu 24.04 (e.g. an EC2 instance):
#
#   sudo bash setup-server.sh pdf-studio.example.com
#
# Installs nginx, Python, LibreOffice (no GUI), Tesseract (English + Hindi) and fonts; creates the pdfstudio
# user and folders; installs the systemd service and the nginx site. Code is copied later by deploy/deploy.sh.
set -euo pipefail
name="${1:?give the server DNS name or IP, e.g. pdf-studio.example.com}"
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
. /etc/os-release
[ "${ID:-}" = ubuntu ] || echo "! Written for Ubuntu 24.04; this is ${PRETTY_NAME:-unknown}. Continuing."
here="$(cd "$(dirname "$0")" && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends \
  nginx python3 python3-venv python3-pip rsync curl \
  libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui libreoffice-draw-nogui \
  tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin \
  fonts-noto-core fonts-noto-cjk fonts-dejavu-core fonts-liberation2

id pdfstudio >/dev/null 2>&1 || useradd --system --home-dir /var/lib/pdf-studio --shell /usr/sbin/nologin pdfstudio
install -d -o pdfstudio -g pdfstudio -m 750 /var/lib/pdf-studio
install -d -m 755 /opt/pdf-studio /opt/pdf-studio/web /opt/pdf-studio/server
install -d -m 750 -g pdfstudio /etc/pdf-studio
if [ ! -f /etc/pdf-studio/server.env ]; then
  sed "s/SERVER_NAME/$name/" "$here/server.env.example" > /etc/pdf-studio/server.env
  chgrp pdfstudio /etc/pdf-studio/server.env && chmod 640 /etc/pdf-studio/server.env
fi

install -m 644 "$here/pdf-studio-server.service" /etc/systemd/system/pdf-studio-server.service
sed "s/SERVER_NAME/$name/" "$here/nginx-pdf-studio.conf" > /etc/nginx/sites-available/pdf-studio
ln -sf /etc/nginx/sites-available/pdf-studio /etc/nginx/sites-enabled/pdf-studio
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl daemon-reload
systemctl enable pdf-studio-server >/dev/null
systemctl reload nginx

echo "✓ Server prepared for $name. Next, from your Mac: deploy/deploy.sh <ssh-user>@$name"
echo "  Then add HTTPS: sudo apt-get install -y certbot python3-certbot-nginx && sudo certbot --nginx -d $name"
