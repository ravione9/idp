#!/usr/bin/env bash
# EC2 preprod deploy — idp-preprod.lenskart.com behind Cloudflare (proxied).
#
#   bash scripts/deploy-prod.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=compose-lib.sh
source "$(dirname "$0")/compose-lib.sh"

idp_ensure_compose_v2

# Auto-detect compose file from running containers
if idp_uses_dev_stack; then
  export COMPOSE_FILE="docker-compose.dev.yml"
else
  export COMPOSE_FILE="docker-compose.yml"
fi
idp_compose_init

PROD_COMPOSE=("${IDP_COMPOSE[@]}" -f docker-compose.prod.yml)
HOSTNAME="${IDP_ORIGIN_HOST:-idp-preprod.lenskart.com}"
PUBLIC_URL="https://${HOSTNAME}"

echo "==> EC2 preprod deploy for ${PUBLIC_URL}"
echo "    Compose: ${COMPOSE_FILE} + docker-compose.prod.yml"

if [[ ! -f .env ]]; then
  cp env.prod.example .env
  echo "    Created .env from env.prod.example — edit secrets before go-live."
fi

if ! grep -q "^PUBLIC_BASE_URL=${PUBLIC_URL}" .env 2>/dev/null; then
  echo "WARN: PUBLIC_BASE_URL should be ${PUBLIC_URL} in .env"
fi

echo "==> Validating compose project..."
"${PROD_COMPOSE[@]}" config -q

echo "==> Building and starting stack (mysql, redis, api)..."
"${PROD_COMPOSE[@]}" up -d --build mysql redis lilg-api lilg-worker

echo "==> Waiting for MySQL..."
for i in $(seq 1 36); do
  cid=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^(idp-mysql|lilg-mysql)$' | head -1 || true)
  if [[ -n "$cid" ]] && docker exec "$cid" mysqladmin ping -h 127.0.0.1 -u root -prootpassword --silent 2>/dev/null; then
    echo "    MySQL ready."
    break
  fi
  sleep 5
  if [[ "$i" -eq 36 ]]; then
    echo "ERROR: MySQL did not become healthy."
    docker logs idp-mysql --tail 40 2>&1 || docker logs lilg-mysql --tail 40 2>&1 || true
    exit 1
  fi
done

echo "==> Waiting for API on :8080 and :80 (up to 3 min)..."
for i in $(seq 1 36); do
  ok8080=false
  ok80=false
  curl -sf http://127.0.0.1:8080/healthz >/dev/null 2>&1 && ok8080=true
  curl -sf http://127.0.0.1:80/healthz >/dev/null 2>&1 && ok80=true
  if $ok8080 && $ok80; then
    echo ""
    echo "=== SUCCESS (origin ready for Cloudflare) ==="
    curl -sf http://127.0.0.1:80/healthz && echo
    echo ""
    echo "Public URL:  ${PUBLIC_URL}/login"
    echo ""
    echo "Cloudflare checklist:"
    echo "  1. DNS A record ${HOSTNAME} → this server public IP, Proxied ON"
    echo "  2. SSL/TLS mode: Flexible (CF HTTPS → origin HTTP :80)"
    echo "  3. AWS Security Group: inbound TCP 80 open"
    echo "  4. WAF: allow /healthz /login /auth/* /api/* /saml/*"
    docker ps --filter name=idp- --filter name=lilg-
    exit 0
  fi
  sleep 5
done

echo ""
echo "=== FAILED — API not healthy on port 80 ==="
bash scripts/diagnose-prod.sh
exit 1
