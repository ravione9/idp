#!/usr/bin/env bash
# Rebuild/restart lilg-api without docker-compose v1.29 ContainerConfig bug.
# Workaround: remove the old container before "up" (do not use compose recreate).
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker-compose -f docker-compose.dev.yml)

if [[ ! -f .env ]]; then
  cp env.dev.example .env
  echo "Created .env from env.dev.example — set MASTER_ADMIN_* and secrets."
fi

echo "==> Building lilg-api..."
"${COMPOSE[@]}" build lilg-api

echo "==> Stopping and removing old idp-api container..."
"${COMPOSE[@]}" stop lilg-api 2>/dev/null || true
docker rm -f idp-api 2>/dev/null || true

echo "==> Starting lilg-api..."
"${COMPOSE[@]}" up -d --no-deps lilg-api

echo "==> Waiting for health (up to 2 min)..."
for i in $(seq 1 24); do
  if curl -sf http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo "API is up."
    curl -sf http://127.0.0.1:8080/healthz && echo
    exit 0
  fi
  sleep 5
done

echo "WARN: API not healthy yet. Logs:"
docker logs idp-api --tail 60 2>&1 || true
exit 1
