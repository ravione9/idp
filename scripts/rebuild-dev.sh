#!/usr/bin/env bash
# Pull latest code and rebuild Docker images without cache (fixes stale COPY src layers)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Pulling latest from origin/main..."
git fetch origin
git reset --hard origin/main
git log -1 --oneline

echo "==> Rebuilding (no cache)..."
docker-compose -f docker-compose.dev.yml build --no-cache lilg-api lilg-worker

echo "==> Starting stack..."
docker-compose -f docker-compose.dev.yml up -d

sleep 10
curl -sf http://127.0.0.1:8080/healthz && echo ""
echo "Done. Open http://$(hostname -I | awk '{print $1}'):8080/login"
