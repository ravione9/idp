#!/usr/bin/env bash
# Rebuild and restart lilg-api (safe on docker-compose v1.29 + modern Docker Engine).
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=compose-lib.sh
source "$(dirname "$0")/compose-lib.sh"
idp_ensure_compose_v2
idp_compose_init

if [[ ! -f .env ]]; then
  cp env.dev.example .env
  echo "Created .env from env.dev.example — set MASTER_ADMIN_* and secrets."
fi

echo "==> Building lilg-api..."
"${IDP_COMPOSE[@]}" build lilg-api

idp_compose_start_api

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
docker logs idp-api --tail 60 2>&1 || docker logs lilg-api --tail 60 2>&1 || true
exit 1
