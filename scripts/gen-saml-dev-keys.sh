#!/usr/bin/env bash
# Generate self-signed SAML IdP key + cert for dev (run on server or laptop)
set -euo pipefail

OUT_DIR="${1:-.}"
CN="${2:-192.168.24.254}"

openssl req -x509 -newkey rsa:2048 \
  -keyout "${OUT_DIR}/idp-dev.key" \
  -out "${OUT_DIR}/idp-dev.crt" \
  -days 825 -nodes \
  -subj "/CN=${CN}/O=Lenskart Dev IdP"

echo "Created ${OUT_DIR}/idp-dev.key and ${OUT_DIR}/idp-dev.crt"
echo "Add to .env (escape newlines as \\n):"
echo "  SAML_IDP_PRIVATE_KEY_PEM=\$(awk '{printf \"%s\\\\n\", \$0}' ${OUT_DIR}/idp-dev.key)"
echo "  SAML_IDP_CERT_PEM=\$(awk '{printf \"%s\\\\n\", \$0}' ${OUT_DIR}/idp-dev.crt)"
