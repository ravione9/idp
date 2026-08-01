#!/usr/bin/env bash
# Fix Cloudflare 526 — origin only sends leaf cert, missing Thawte intermediate.
# Downloads the intermediate from DigiCert, inserts into DB, rebuilds API.
#
#   bash scripts/fix-tls-chain.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=compose-lib.sh
source "$(dirname "$0")/compose-lib.sh"

if idp_uses_dev_stack; then
  export COMPOSE_FILE="docker-compose.dev.yml"
else
  export COMPOSE_FILE="docker-compose.yml"
fi
idp_ensure_compose_v2
idp_compose_init

echo "==> Step 1: Fetch correct intermediate via AIA from the actual leaf cert..."
INTERMEDIATE_PEM=""

# Extract the AIA URL from the leaf cert currently served by the API
# This guarantees we get the EXACT intermediate that chains to that cert
AIA_URL=$(echo | openssl s_client -connect 127.0.0.1:443 \
    -servername "${HOSTNAME}" 2>/dev/null \
  | openssl x509 -noout -text 2>/dev/null \
  | grep "CA Issuers" | head -1 \
  | sed 's/.*URI:\(.*\)/\1/' | tr -d '[:space:]' || true)

if [[ -n "$AIA_URL" ]]; then
  echo "    AIA URL from cert: $AIA_URL"
  if curl -sf --max-time 20 "$AIA_URL" -o /tmp/aia-inter.crt 2>/dev/null; then
    if openssl x509 -inform DER -in /tmp/aia-inter.crt -out /tmp/aia-inter.pem 2>/dev/null; then
      INTERMEDIATE_PEM=$(cat /tmp/aia-inter.pem)
      echo "    Downloaded (DER): $(openssl x509 -noout -subject -in /tmp/aia-inter.pem 2>/dev/null)"
    elif openssl x509 -inform PEM -in /tmp/aia-inter.crt -out /tmp/aia-inter.pem 2>/dev/null; then
      INTERMEDIATE_PEM=$(cat /tmp/aia-inter.pem)
      echo "    Downloaded (PEM): $(openssl x509 -noout -subject -in /tmp/aia-inter.pem 2>/dev/null)"
    fi
  fi
fi

# Fallback: crt.sh lookup by issuer name from the leaf cert
if [[ -z "$INTERMEDIATE_PEM" ]]; then
  echo "    AIA failed — trying crt.sh by issuer..."
  ISSUER_CN=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$HOSTNAME" 2>/dev/null \
    | openssl x509 -noout -issuer 2>/dev/null \
    | sed 's/.*CN\s*=\s*//' | sed 's/[,/].*//' | tr -d ' ' || true)
  if [[ -n "$ISSUER_CN" ]]; then
    CRTSH_URL="https://crt.sh/?CN=${ISSUER_CN}&match=LIKE&output=json"
    CRT_ID=$(curl -sf --max-time 15 "$CRTSH_URL" 2>/dev/null \
      | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*' || true)
    if [[ -n "$CRT_ID" ]]; then
      if curl -sf --max-time 20 "https://crt.sh/?d=${CRT_ID}" -o /tmp/crtsh-inter.crt 2>/dev/null; then
        if openssl x509 -inform DER -in /tmp/crtsh-inter.crt -out /tmp/aia-inter.pem 2>/dev/null \
          || openssl x509 -inform PEM -in /tmp/crtsh-inter.crt -out /tmp/aia-inter.pem 2>/dev/null; then
          INTERMEDIATE_PEM=$(cat /tmp/aia-inter.pem)
          echo "    Downloaded via crt.sh id $CRT_ID"
        fi
      fi
    fi
  fi
fi

if [[ -z "$INTERMEDIATE_PEM" ]]; then
  echo "ERROR: Could not download Thawte intermediate automatically."
  echo ""
  echo "Manual fix — do this on the server:"
  echo "  1. Get your fullchain.pem from whoever issued the *.lenskart.com cert"
  echo "  2. Run: bash scripts/install-origin-cert.sh /path/to/fullchain.pem /path/to/key.pem"
  echo "  OR"
  echo "  1. GUI → Admin → Portal SSL"
  echo "  2. Paste the Thawte TLS RSA CA G1 PEM in the CA/Intermediate field"
  echo "  3. Click Upload & Activate"
  echo "  4. docker compose -f docker-compose.dev.yml -f docker-compose.prod.yml up -d --build lilg-api"
  exit 1
fi

echo "    Intermediate issuer: $(echo "$INTERMEDIATE_PEM" | openssl x509 -noout -subject 2>/dev/null)"

echo ""
echo "==> Step 2: Check cert in DB..."
HAS_CERT=$(docker exec idp-mysql mysql -u root -prootpassword lilg -N -e \
  "SELECT CASE WHEN portal_ssl_cert IS NOT NULL AND portal_ssl_cert != '' THEN 'yes' ELSE 'no' END FROM general_settings WHERE id = 1;" 2>/dev/null | tr -d '[:space:]')

if [[ "$HAS_CERT" == "yes" ]]; then
  echo "    Leaf cert found in DB"
else
  echo "ERROR: No certificate in DB — upload via GUI first, then re-run this script"
  exit 1
fi

echo ""
echo "==> Step 3: Save intermediate to DB portal_ssl_ca..."
INTER_B64=$(echo "$INTERMEDIATE_PEM" | base64 -w0)
docker exec idp-mysql mysql -u root -prootpassword lilg -e "
UPDATE general_settings SET
  portal_ssl_ca = CAST(FROM_BASE64('${INTER_B64}') AS CHAR),
  portal_https_enabled = 1,
  portal_allow_http    = 1,
  updated_at = UTC_TIMESTAMP()
WHERE id = 1;
"
echo "    Intermediate saved"

echo ""
echo "==> Step 4: Rebuild API with chain fix (git pull already has buildTlsCertChain)..."
"${IDP_COMPOSE[@]}" -f docker-compose.prod.yml up -d --build --force-recreate --no-deps lilg-api

echo ""
echo "==> Waiting for HTTPS on :443..."
for i in $(seq 1 30); do
  if curl -skf "https://127.0.0.1/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 3
  if [[ "$i" -eq 30 ]]; then
    echo "ERROR: HTTPS not responding"
    docker logs idp-api --tail 30
    exit 1
  fi
done

echo ""
echo "==> Verify chain count..."
HOSTNAME="${IDP_ORIGIN_HOST:-idp-preprod.lenskart.com}"
CHAIN_COUNT=$(echo | openssl s_client -connect 127.0.0.1:443 \
  -servername "${HOSTNAME}" -showcerts 2>/dev/null | grep -c "BEGIN CERTIFICATE" || echo 0)
echo "    Certificates in handshake: $CHAIN_COUNT"

if [[ "$CHAIN_COUNT" -ge 2 ]]; then
  echo ""
  echo "=== FIXED ==="
  curl -sk "https://127.0.0.1/healthz" && echo
  echo ""
  echo "Test Cloudflare:"
  sleep 3
  curl -sI "https://${HOSTNAME}/healthz" | head -5
else
  echo "ERROR: still only $CHAIN_COUNT cert in handshake"
  echo "  Manually upload fullchain.pem (leaf+intermediate together) in Portal SSL GUI"
fi
