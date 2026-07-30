#!/usr/bin/env bash
# How many certs does origin :443 actually SEND during TLS handshake?
# Cloudflare 526 with valid wildcard = usually only leaf sent (missing intermediate).
set -euo pipefail
cd "$(dirname "$0")/.."

HOSTNAME="${IDP_ORIGIN_HOST:-idp.lenskart.com}"
PUB_IP=$(curl -sf --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "3.6.124.122")

echo "=== Origin TLS handshake (certs SENT by server, not client-built) ==="
for TARGET in "127.0.0.1" "$PUB_IP"; do
  echo ""
  echo "--- ${TARGET}:443 (SNI ${HOSTNAME}) ---"
  if ! command -v openssl >/dev/null 2>&1; then
    echo "install openssl"
    exit 1
  fi
  OUT=$(echo | openssl s_client -connect "${TARGET}:443" -servername "$HOSTNAME" -showcerts 2>/dev/null || true)
  COUNT=$(echo "$OUT" | grep -c "BEGIN CERTIFICATE" || echo 0)
  echo "  Certificates sent in handshake: ${COUNT}"
  echo "$OUT" | openssl x509 -noout -subject -issuer 2>/dev/null | sed 's/^/  /' || true
  if [[ "$COUNT" -lt 2 ]]; then
    echo "  *** FAIL: Cloudflare Full (strict) needs leaf + intermediate (count >= 2) ***"
    echo "  Fix: GUI → Portal SSL → paste Thawte/DigiCert intermediate in CA field, re-upload"
    echo "       OR paste fullchain.pem (leaf+intermediate) in Certificate field"
    echo "       Then: git pull && docker restart idp-api"
  else
    echo "  OK: chain sent to clients"
  fi
done

echo ""
echo "=== DB: portal_ssl_ca populated? ==="
docker exec idp-mysql mysql -u root -prootpassword lilg -N -e \
  "SELECT CASE WHEN portal_ssl_ca IS NOT NULL AND portal_ssl_ca != '' THEN 'yes' ELSE 'NO — add intermediate' END,
          portal_https_enabled, portal_allow_http
     FROM general_settings WHERE id = 1;" 2>/dev/null || true

echo ""
echo "=== Cloudflare edge ==="
curl -sI "https://${HOSTNAME}/healthz" 2>&1 | head -3
