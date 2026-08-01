#!/usr/bin/env bash
# Enable HTTPS on origin :443 when you cannot change Cloudflare SSL mode.
#
# Cloudflare Full SSL connects to origin HTTPS :443 (not HTTP :80).
# This installs a self-signed cert into general_settings and restarts the API.
# Works with Cloudflare "Full" — NOT "Full (strict)" (that needs a CA-signed cert).
#
#   bash scripts/enable-origin-https.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

HOSTNAME="${IDP_ORIGIN_HOST:-idp-preprod.lenskart.com}"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

echo "==> Enable origin HTTPS for Cloudflare Full SSL (no CF dashboard change)"
echo "    Hostname: $HOSTNAME"
echo ""

if ! docker ps --format '{{.Names}}' | grep -q '^idp-mysql$'; then
  echo "ERROR: idp-mysql container not running"
  exit 1
fi

echo "==> Generating self-signed certificate (825 days)..."
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem" -days 825 \
  -subj "/CN=${HOSTNAME}" \
  -addext "subjectAltName=DNS:${HOSTNAME}" 2>/dev/null \
  || openssl req -x509 -newkey rsa:2048 -nodes \
       -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem" -days 825 \
       -subj "/CN=${HOSTNAME}"

CERT_B64=$(base64 -w0 "$WORKDIR/cert.pem")
KEY_B64=$(base64 -w0 "$WORKDIR/key.pem")

echo "==> Saving certificate to MySQL (general_settings)..."
docker exec idp-mysql mysql -u root -prootpassword lilg -e "
UPDATE general_settings SET
  portal_ssl_cert = CAST(FROM_BASE64('${CERT_B64}') AS CHAR),
  portal_ssl_key  = CAST(FROM_BASE64('${KEY_B64}') AS CHAR),
  portal_ssl_ca   = NULL,
  portal_ssl_cn   = '${HOSTNAME}',
  portal_ssl_expiry = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 825 DAY),
  portal_ssl_sans = '${HOSTNAME}',
  portal_https_enabled = 1,
  portal_allow_http    = 1,
  updated_at = UTC_TIMESTAMP()
WHERE id = 1;
"

echo "==> Open host firewall :443 (if ufw active)..."
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q active; then
  ufw allow 443/tcp || true
  ufw reload || true
fi

echo "==> Restart API (HTTPS only starts on boot)..."
docker restart idp-api

echo "==> Waiting for HTTPS on :8443 inside container / :443 on host..."
for i in $(seq 1 30); do
  if curl -skf https://127.0.0.1:443/healthz >/dev/null 2>&1 \
      || curl -skf https://127.0.0.1/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 3
  if [[ "$i" -eq 30 ]]; then
    echo "ERROR: HTTPS not responding after restart"
    docker logs idp-api --tail 30
    exit 1
  fi
done

PUB_IP=$(curl -sf --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)

echo ""
echo "=== Origin HTTPS ready ==="
curl -sk https://127.0.0.1/healthz && echo
if [[ -n "$PUB_IP" ]]; then
  echo ""
  echo "Public test:"
  curl -sk "https://${PUB_IP}/healthz" && echo || echo "WARN: public :443 not reachable — check AWS SG inbound TCP 443"
fi

echo ""
echo "Now test Cloudflare (orange cloud can stay ON):"
echo "  curl -sI https://${HOSTNAME}/healthz"
echo ""
echo "If Cloudflare shows 526 (not 521):"
echo "  Self-signed is rejected by Full (strict). Run:"
echo "    bash scripts/fix-cloudflare-526.sh admin@lenskart.com"
echo ""
echo "If still 521:"
echo "  • AWS Security Group must allow inbound TCP 443"
echo "  • Run: bash scripts/test-cloudflare-origin.sh"
