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

echo "==> Step 1: Fetch Thawte TLS RSA CA G1 intermediate from DigiCert..."
INTERMEDIATE_URL="https://cacerts.digicert.com/ThawteRSACA2018.crt"
INTERMEDIATE_PEM=""

# Try downloading and converting from DER
if curl -sf --max-time 15 "$INTERMEDIATE_URL" -o /tmp/thawte-inter.crt 2>/dev/null; then
  if openssl x509 -inform DER -in /tmp/thawte-inter.crt -out /tmp/thawte-inter.pem 2>/dev/null; then
    INTERMEDIATE_PEM=$(cat /tmp/thawte-inter.pem)
    echo "    Downloaded Thawte RSA CA 2018 intermediate"
  fi
fi

# Fallback: try PEM URL
if [[ -z "$INTERMEDIATE_PEM" ]]; then
  FALLBACK_URL="https://crt.sh/?d=2242286973"
  if curl -sf --max-time 15 "$FALLBACK_URL" -o /tmp/thawte-inter2.crt 2>/dev/null; then
    if openssl x509 -inform DER -in /tmp/thawte-inter2.crt -out /tmp/thawte-inter.pem 2>/dev/null \
      || openssl x509 -inform PEM -in /tmp/thawte-inter2.crt -out /tmp/thawte-inter.pem 2>/dev/null; then
      INTERMEDIATE_PEM=$(cat /tmp/thawte-inter.pem)
      echo "    Downloaded via crt.sh"
    fi
  fi
fi

# Fallback: extract from AIA of the leaf cert
if [[ -z "$INTERMEDIATE_PEM" ]]; then
  echo "    Trying AIA extraction from leaf cert..."
  AIA_URL=$(echo | openssl s_client -connect 127.0.0.1:443 -servername idp.lenskart.com 2>/dev/null \
    | openssl x509 -noout -text 2>/dev/null \
    | grep "CA Issuers" | head -1 | sed 's/.*URI://;s/ .*//' | tr -d '[:space:]' || true)
  if [[ -n "$AIA_URL" ]]; then
    if curl -sf --max-time 15 "$AIA_URL" -o /tmp/thawte-aia.crt 2>/dev/null; then
      if openssl x509 -inform DER -in /tmp/thawte-aia.crt -out /tmp/thawte-inter.pem 2>/dev/null \
        || openssl x509 -inform PEM -in /tmp/thawte-aia.crt -out /tmp/thawte-inter.pem 2>/dev/null; then
        INTERMEDIATE_PEM=$(cat /tmp/thawte-inter.pem)
        echo "    Downloaded via AIA: $AIA_URL"
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
CHAIN_COUNT=$(echo | openssl s_client -connect 127.0.0.1:443 \
  -servername idp.lenskart.com -showcerts 2>/dev/null | grep -c "BEGIN CERTIFICATE" || echo 0)
echo "    Certificates in handshake: $CHAIN_COUNT"

if [[ "$CHAIN_COUNT" -ge 2 ]]; then
  echo ""
  echo "=== FIXED ==="
  curl -sk "https://127.0.0.1/healthz" && echo
  echo ""
  echo "Test Cloudflare:"
  sleep 3
  curl -sI "https://idp.lenskart.com/healthz" | head -5
else
  echo "ERROR: still only $CHAIN_COUNT cert in handshake"
  echo "  Manually upload fullchain.pem (leaf+intermediate together) in Portal SSL GUI"
fi
