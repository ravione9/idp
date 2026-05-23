#!/usr/bin/env bash
# Fix docker-compose v1.29 "KeyError: ContainerConfig" with newer Docker Engine.
# Also cleans stale idp-* containers and brings the stack up fresh.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker-compose -f docker-compose.dev.yml)

echo "==> Stopping stack..."
"${COMPOSE[@]}" down --remove-orphans 2>/dev/null || true

echo "==> Removing stale idp containers..."
docker rm -f idp-api idp-worker idp-mysql idp-redis idp-localstack 2>/dev/null || true
docker ps -a --format '{{.Names}}' | grep -E '^idp-|_idp-' | xargs -r docker rm -f 2>/dev/null || true

echo "==> Ensuring .env exists..."
if [[ ! -f .env ]]; then
  cp env.dev.example .env
  echo "Created .env from env.dev.example — edit secrets if needed."
fi

echo "==> Starting stack (force recreate)..."
"${COMPOSE[@]}" up -d --build --force-recreate --remove-orphans

echo "==> Waiting for API (up to 2 min)..."
for i in $(seq 1 24); do
  if curl -sf http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo "API is up."
    curl -sf http://127.0.0.1:8080/healthz && echo
    curl -sf http://127.0.0.1:8080/readyz && echo || echo "readyz: still starting DB..."
    exit 0
  fi
  sleep 5
done

echo "WARN: API not responding yet. Check logs:"
echo "  docker logs idp-api --tail 100"
docker logs idp-api --tail 40 2>&1 || true
exit 1
