#!/usr/bin/env bash
# Fix Cloudflare 526 — origin has self-signed cert; Full (strict) needs CA-signed cert.
#
#   bash scripts/fix-cloudflare-526.sh [admin@email]
#
set -euo pipefail
cd "$(dirname "$0")/.."

HOSTNAME="${IDP_ORIGIN_HOST:-idp.lenskart.com}"
EMAIL="${1:-admin@lenskart.com}"

echo "==> Diagnose origin TLS (526 = Cloudflare rejects origin certificate)"
if command -v openssl >/dev/null 2>&1; then
  echo | openssl s_client -connect 127.0.0.1:443 -servername "$HOSTNAME" 2>/dev/null \
    | openssl x509 -noout -subject -issuer -dates 2>/dev/null || echo "WARN: no TLS on local :443"
  ISSUER=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$HOSTNAME" 2>/dev/null \
    | openssl x509 -noout -issuer 2>/dev/null || true)
  if echo "$ISSUER" | grep -q "issuer=CN = ${HOSTNAME}\|issuer=CN=${HOSTNAME}"; then
    echo ""
    echo "  PROBLEM: Self-signed certificate (issuer = subject)"
    echo "  Cloudflare Full (strict) requires Let's Encrypt or Cloudflare Origin Certificate"
  fi
else
  echo "  (install openssl for local cert check)"
fi

echo ""
echo "==> Step 1: Recreate API with ACME webroot (required for Let's Encrypt)"
# shellcheck source=compose-lib.sh
source "$(dirname "$0")/compose-lib.sh"
if idp_uses_dev_stack; then
  export COMPOSE_FILE="docker-compose.dev.yml"
else
  export COMPOSE_FILE="docker-compose.yml"
fi
idp_ensure_compose_v2
idp_compose_init
PROD_COMPOSE=("${IDP_COMPOSE[@]}" -f docker-compose.prod.yml)
mkdir -p acme-webroot
"${PROD_COMPOSE[@]}" up -d --force-recreate --no-deps lilg-api

echo ""
echo "==> Step 2: Verify ACME path reachable (Cloudflare must forward :80 to origin)"
TESTFILE="fix-526-$(date +%s)"
echo ok > "acme-webroot/${TESTFILE}"
sleep 2
if curl -sf "http://127.0.0.1/.well-known/acme-challenge/${TESTFILE}" | grep -q ok; then
  echo "  OK: local ACME webroot"
else
  echo "  FAIL: API not serving /.well-known/acme-challenge — git pull + recreate api container"
  exit 1
fi
rm -f "acme-webroot/${TESTFILE}"

echo ""
echo "==> Step 3: Request Let's Encrypt certificate"
bash scripts/enable-origin-letsencrypt.sh "$EMAIL"

echo ""
echo "==> Step 4: Verify issuer is no longer self-signed"
if command -v openssl >/dev/null 2>&1; then
  echo | openssl s_client -connect 127.0.0.1:443 -servername "$HOSTNAME" 2>/dev/null \
    | openssl x509 -noout -subject -issuer -dates 2>/dev/null
fi

echo ""
echo "Test: curl -sI https://idp.lenskart.com/healthz  (expect HTTP 200)"
