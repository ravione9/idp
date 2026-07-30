#!/usr/bin/env bash
# Fix docker-compose v1.29 "KeyError: ContainerConfig" with newer Docker Engine.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=compose-lib.sh
source "$(dirname "$0")/compose-lib.sh"
idp_compose_init

echo "==> Stopping stack..."
"${IDP_COMPOSE[@]}" down --remove-orphans 2>/dev/null || true

echo "==> Removing stale idp containers..."
docker rm -f idp-api lilg-api idp-worker idp-mysql idp-redis idp-localstack 2>/dev/null || true
docker ps -a --format '{{.Names}}' | grep -E '^idp-|_idp-|^lilg-api$' | xargs -r docker rm -f 2>/dev/null || true

echo "==> Ensuring .env exists..."
if [[ ! -f .env ]]; then
  cp env.dev.example .env
  echo "Created .env from env.dev.example — edit secrets if needed."
fi

echo "==> Starting stack..."
idp_rm_stale_api
"${IDP_COMPOSE[@]}" up -d --build --remove-orphans

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
