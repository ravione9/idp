#!/usr/bin/env bash
# Renew Let's Encrypt and reload origin cert into IdP (weekly cron).
set -euo pipefail
cd "$(dirname "$0")/.."

HOSTNAME="${IDP_ORIGIN_HOST:-idp-preprod.lenskart.com}"
LE_DIR="/etc/letsencrypt/live/${HOSTNAME}"

certbot renew --webroot -w "$(pwd)/acme-webroot" --quiet

[[ -f "${LE_DIR}/fullchain.pem" ]] || exit 0

CERT_B64=$(base64 -w0 "${LE_DIR}/fullchain.pem")
KEY_B64=$(base64 -w0 "${LE_DIR}/privkey.pem")

docker exec idp-mysql mysql -u root -prootpassword lilg -e "
UPDATE general_settings SET
  portal_ssl_cert = CAST(FROM_BASE64('${CERT_B64}') AS CHAR),
  portal_ssl_key  = CAST(FROM_BASE64('${KEY_B64}') AS CHAR),
  updated_at = UTC_TIMESTAMP()
WHERE id = 1;
"

docker restart idp-api
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) renewed ${HOSTNAME}"
