#!/usr/bin/env bash
# Fix Cloudflare 526 (Invalid SSL certificate) — install Let's Encrypt on origin :443.
# Cloudflare Full (strict) rejects self-signed certs; needs a public CA cert.
#
# Requires: port 80 reachable (HTTP-01 via Cloudflare → origin :80).
#   bash scripts/enable-origin-letsencrypt.sh [admin@email]
#
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=compose-lib.sh
source "$(dirname "$0")/compose-lib.sh"

HOSTNAME="${IDP_ORIGIN_HOST:-idp-preprod.lenskart.com}"
EMAIL="${1:-admin@lenskart.com}"

if idp_uses_dev_stack; then
  export COMPOSE_FILE="docker-compose.dev.yml"
else
  export COMPOSE_FILE="docker-compose.yml"
fi
idp_ensure_compose_v2
idp_compose_init
PROD_COMPOSE=("${IDP_COMPOSE[@]}" -f docker-compose.prod.yml)

echo "==> Let's Encrypt origin cert for Cloudflare Full (strict) — fixes error 526"
echo "    Domain: $HOSTNAME"
echo "    Email:  $EMAIL"
echo ""

mkdir -p acme-webroot
chmod 755 acme-webroot

echo "==> Ensure API serves ACME webroot on :80..."
"${PROD_COMPOSE[@]}" up -d --no-deps lilg-api

if ! command -v certbot >/dev/null 2>&1; then
  echo "==> Installing certbot..."
  apt-get update -qq && apt-get install -y -qq certbot
fi

echo "==> Requesting certificate (HTTP-01 via http://${HOSTNAME}/.well-known/...)..."
certbot certonly --webroot \
  -w "$(pwd)/acme-webroot" \
  -d "$HOSTNAME" \
  --email "$EMAIL" \
  --agree-tos --non-interactive --no-eff-email

LE_DIR="/etc/letsencrypt/live/${HOSTNAME}"
if [[ ! -f "${LE_DIR}/fullchain.pem" || ! -f "${LE_DIR}/privkey.pem" ]]; then
  echo "ERROR: certbot did not create ${LE_DIR}"
  exit 1
fi

CERT_B64=$(base64 -w0 "${LE_DIR}/fullchain.pem")
KEY_B64=$(base64 -w0 "${LE_DIR}/privkey.pem")

echo "==> Installing cert into MySQL..."
docker exec idp-mysql mysql -u root -prootpassword lilg -e "
UPDATE general_settings SET
  portal_ssl_cert = CAST(FROM_BASE64('${CERT_B64}') AS CHAR),
  portal_ssl_key  = CAST(FROM_BASE64('${KEY_B64}') AS CHAR),
  portal_ssl_ca   = NULL,
  portal_ssl_cn   = '${HOSTNAME}',
  portal_ssl_expiry = (
    SELECT STR_TO_DATE(
      REPLACE(
        (SELECT SUBSTRING_INDEX(
          SUBSTRING_INDEX(CAST(FROM_BASE64('${CERT_B64}') AS CHAR), 'Not After :', -1),
          'GMT', 1
        )),
        '  ', ' '
      ),
      '%b %d %H:%M:%S %Y'
    )
  ),
  portal_ssl_sans = '${HOSTNAME}',
  portal_https_enabled = 1,
  portal_allow_http    = 1,
  updated_at = UTC_TIMESTAMP()
WHERE id = 1;
" 2>/dev/null || docker exec idp-mysql mysql -u root -prootpassword lilg -e "
UPDATE general_settings SET
  portal_ssl_cert = CAST(FROM_BASE64('${CERT_B64}') AS CHAR),
  portal_ssl_key  = CAST(FROM_BASE64('${KEY_B64}') AS CHAR),
  portal_ssl_cn   = '${HOSTNAME}',
  portal_ssl_sans = '${HOSTNAME}',
  portal_https_enabled = 1,
  portal_allow_http    = 1,
  updated_at = UTC_TIMESTAMP()
WHERE id = 1;
"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q active; then
  ufw allow 443/tcp 2>/dev/null || true
  ufw reload 2>/dev/null || true
fi

echo "==> Restart API..."
docker restart idp-api

for i in $(seq 1 30); do
  if curl -skf "https://127.0.0.1/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 3
done

PUB_IP=$(curl -sf --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)

echo ""
echo "=== Let's Encrypt origin HTTPS ready ==="
curl -sk "https://127.0.0.1/healthz" && echo
if [[ -n "$PUB_IP" ]]; then
  curl -sk "https://${PUB_IP}/healthz" && echo
fi

echo ""
echo "Test Cloudflare (should be HTTP 200, not 526):"
echo "  curl -sI https://${HOSTNAME}/healthz"
echo ""
echo "Auto-renewal: add to root crontab:"
echo "  0 3 * * 1 cd /opt/idp && bash scripts/renew-letsencrypt.sh >> /var/log/idp-cert-renew.log 2>&1"
