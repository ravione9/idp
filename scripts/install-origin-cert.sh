#!/usr/bin/env bash
# Install a CA-signed certificate on origin :443 (fixes Cloudflare 526 Full strict).
#
# Wildcard *.lenskart.com covers idp-preprod.lenskart.com.
#
# Usage:
#   bash scripts/install-origin-cert.sh /path/to/cert.pem /path/to/key.pem
#   bash scripts/install-origin-cert.sh cert.pem key.pem ca-chain.pem
#
# If you have a .pfx file:
#   openssl pkcs12 -in wildcard.pfx -nocerts -out key.pem -nodes
#   openssl pkcs12 -in wildcard.pfx -clcerts -nokeys -out cert.pem
#   openssl pkcs12 -in wildcard.pfx -cacerts -nokeys -out ca.pem
#
set -euo pipefail
cd "$(dirname "$0")/.."

HOSTNAME="${IDP_ORIGIN_HOST:-idp-preprod.lenskart.com}"
CERT_FILE="${1:-}"
KEY_FILE="${2:-}"
CA_FILE="${3:-}"

if [[ -z "$CERT_FILE" || -z "$KEY_FILE" ]]; then
  echo "Usage: bash scripts/install-origin-cert.sh <cert.pem> <key.pem> [ca-chain.pem]"
  exit 1
fi
if [[ ! -f "$CERT_FILE" || ! -f "$KEY_FILE" ]]; then
  echo "ERROR: cert or key file not found"
  exit 1
fi
if ! docker ps --format '{{.Names}}' | grep -q '^idp-mysql$'; then
  echo "ERROR: idp-mysql container not running"
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl required"
  exit 1
fi

echo "==> Install origin certificate for Cloudflare Full (strict)"
echo "    Hostname: $HOSTNAME"
echo "    Cert:     $CERT_FILE"
echo "    Key:      $KEY_FILE"
[[ -n "$CA_FILE" && -f "$CA_FILE" ]] && echo "    CA:       $CA_FILE"
echo ""

echo "==> Validate certificate + key..."
if ! openssl x509 -in "$CERT_FILE" -noout 2>/dev/null; then
  echo "ERROR: $CERT_FILE is not a valid PEM certificate"
  exit 1
fi
if ! openssl rsa -in "$KEY_FILE" -check -noout 2>/dev/null \
   && ! openssl ec -in "$KEY_FILE" -check -noout 2>/dev/null \
   && ! openssl pkey -in "$KEY_FILE" -check -noout 2>/dev/null; then
  echo "ERROR: $KEY_FILE is not a valid private key"
  exit 1
fi
if ! openssl x509 -in "$CERT_FILE" -noout -checkend 86400 2>/dev/null; then
  echo "ERROR: certificate expires within 24 hours or is already expired"
  openssl x509 -in "$CERT_FILE" -noout -dates
  exit 1
fi
CERT_PUB=$(mktemp)
KEY_PUB=$(mktemp)
trap 'rm -f "$CERT_PUB" "$KEY_PUB"' RETURN
openssl x509 -in "$CERT_FILE" -noout -pubkey >"$CERT_PUB" 2>/dev/null
openssl pkey -in "$KEY_FILE" -pubout >"$KEY_PUB" 2>/dev/null
if ! diff -q "$CERT_PUB" "$KEY_PUB" >/dev/null 2>&1; then
  echo "ERROR: private key does not match certificate"
  exit 1
fi

echo "==> Certificate details:"
openssl x509 -in "$CERT_FILE" -noout -subject -issuer -dates
echo "    SANs:"
openssl x509 -in "$CERT_FILE" -noout -ext subjectAltName 2>/dev/null | tr ',' '\n' | grep -i DNS || true

if ! openssl x509 -in "$CERT_FILE" -noout -text 2>/dev/null | grep -qE "DNS:\*\.lenskart\.com|DNS:${HOSTNAME}"; then
  echo "WARN: cert may not cover ${HOSTNAME} — confirm SAN includes *.lenskart.com or ${HOSTNAME}"
fi

CN=$(openssl x509 -in "$CERT_FILE" -noout -subject 2>/dev/null | sed -n 's/.*CN\s*=\s*\([^,/]*\).*/\1/p' | head -1)
EXPIRY_RAW=$(openssl x509 -in "$CERT_FILE" -noout -enddate 2>/dev/null | cut -d= -f2-)
EXPIRY_MYSQL=$(date -u -d "$EXPIRY_RAW" '+%Y-%m-%d %H:%i:%s' 2>/dev/null || echo "")
SANS=$(openssl x509 -in "$CERT_FILE" -noout -ext subjectAltName 2>/dev/null | tr -d ' ' || true)

CERT_B64=$(base64 -w0 "$CERT_FILE")
KEY_B64=$(base64 -w0 "$KEY_FILE")
CA_SQL="NULL"
if [[ -n "$CA_FILE" && -f "$CA_FILE" ]]; then
  CA_B64=$(base64 -w0 "$CA_FILE")
  CA_SQL="CAST(FROM_BASE64('${CA_B64}') AS CHAR)"
fi

# Escape single quotes for SQL strings
CN_ESC=${CN//\'/\'\'}
SANS_ESC=${SANS//\'/\'\'}

echo ""
echo "==> Saving to MySQL (general_settings)..."
docker exec idp-mysql mysql -u root -prootpassword lilg -e "
UPDATE general_settings SET
  portal_ssl_cert = CAST(FROM_BASE64('${CERT_B64}') AS CHAR),
  portal_ssl_key  = CAST(FROM_BASE64('${KEY_B64}') AS CHAR),
  portal_ssl_ca   = ${CA_SQL},
  portal_ssl_cn   = '${CN_ESC:-$HOSTNAME}',
  portal_ssl_expiry = $([ -n "$EXPIRY_MYSQL" ] && echo "'${EXPIRY_MYSQL}'" || echo 'NULL'),
  portal_ssl_sans = '${SANS_ESC}',
  portal_https_enabled = 1,
  portal_allow_http    = 1,
  updated_at = UTC_TIMESTAMP()
WHERE id = 1;
"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q active; then
  ufw allow 443/tcp 2>/dev/null || true
  ufw reload 2>/dev/null || true
fi

echo "==> Restart API (HTTPS loads on boot)..."
docker restart idp-api

echo "==> Waiting for :443..."
for i in $(seq 1 30); do
  if curl -skf "https://127.0.0.1/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 3
  if [[ "$i" -eq 30 ]]; then
    echo "ERROR: HTTPS not responding"
    docker logs idp-api --tail 40
    exit 1
  fi
done

echo ""
echo "=== Installed ==="
echo | openssl s_client -connect 127.0.0.1:443 -servername "$HOSTNAME" 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates 2>/dev/null || true
curl -sk "https://127.0.0.1/healthz" && echo

PUB_IP=$(curl -sf --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
[[ -n "$PUB_IP" ]] && curl -sk "https://${PUB_IP}/healthz" && echo

echo ""
echo "Test Cloudflare (expect HTTP 200, not 526):"
echo "  curl -sI https://${HOSTNAME}/healthz"
