#!/usr/bin/env bash
# Fix Cloudflare error 521 — origin not listening on port 80.
# App runs on :8080 inside Docker; Cloudflare proxied DNS hits origin :80.
#
#   bash scripts/fix-cloudflare-521.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=compose-lib.sh
source "$(dirname "$0")/compose-lib.sh"

idp_ensure_compose_v2
if idp_uses_dev_stack; then
  export COMPOSE_FILE="docker-compose.dev.yml"
else
  export COMPOSE_FILE="docker-compose.yml"
fi
idp_compose_init

PROD_COMPOSE=("${IDP_COMPOSE[@]}" -f docker-compose.prod.yml)

echo "==> Fix Cloudflare 521 — expose origin port 80"
echo "    Using: ${COMPOSE_FILE} + docker-compose.prod.yml"

git pull --ff-only 2>/dev/null || echo "WARN: git pull failed — continuing with local files"

# Remove duplicate COOKIE_SECURE=false if PUBLIC prod URL is set
if grep -q '^PUBLIC_BASE_URL=https://idp.lenskart.com' .env 2>/dev/null; then
  if grep -c '^COOKIE_SECURE=' .env 2>/dev/null | grep -qv '^1$'; then
    echo "WARN: .env has multiple COOKIE_SECURE lines — keep only: COOKIE_SECURE=true"
  fi
fi

echo "==> Validating compose project..."
if ! "${PROD_COMPOSE[@]}" config -q; then
  echo "ERROR: compose config invalid — not removing idp-api"
  echo "  Quick restore (8080 only): docker compose -f docker-compose.dev.yml up -d --build lilg-api"
  exit 1
fi

echo "==> Recreating API container with ports 80:8080 + 8080:8080..."
idp_rm_stale_api 2>/dev/null || true
"${PROD_COMPOSE[@]}" up -d --build --force-recreate --no-deps lilg-api

echo "==> Waiting for :80 healthz..."
for i in $(seq 1 24); do
  if curl -sf http://127.0.0.1:80/healthz >/dev/null 2>&1; then
    echo ""
    echo "=== FIXED ==="
    curl -sf http://127.0.0.1:80/healthz && echo
    echo ""
    echo "Now verify:"
    echo "  curl -sI https://idp.lenskart.com/healthz   # should be HTTP 200, not 521"
    echo ""
    echo "If still 521, open AWS Security Group inbound TCP 80 from 0.0.0.0/0"
    echo "Cloudflare SSL/TLS mode must be: Flexible"
    ss -tlnp 2>/dev/null | grep ':80 ' || netstat -tlnp 2>/dev/null | grep ':80 ' || true
    exit 0
  fi
  sleep 5
done

echo "ERROR: port 80 still not responding"
bash scripts/diagnose-prod.sh
exit 1
