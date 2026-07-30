#!/usr/bin/env bash
# =============================================================================
# Generate self-signed SAML IdP RSA-2048 key + certificate (3-year validity)
# and automatically patch .env on the dev server.
#
# Usage:
#   bash scripts/gen-saml-dev-keys.sh          # generates + patches /opt/idp/.env
#   bash scripts/gen-saml-dev-keys.sh /tmp      # outputs files to /tmp only
#   bash scripts/gen-saml-dev-keys.sh . myhost  # custom CN
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUT_DIR="${1:-${REPO_ROOT}}"
CN="${2:-192.168.24.254}"
DAYS=1095   # 3 years (365 × 3)

KEY_FILE="${OUT_DIR}/idp.key"
CRT_FILE="${OUT_DIR}/idp.crt"

echo "==> Generating RSA-2048 self-signed certificate"
echo "    CN:      ${CN}"
echo "    Valid:   ${DAYS} days (~3 years)"
echo "    Expires: $(date -d "+${DAYS} days" '+%Y-%m-%d' 2>/dev/null || date -v+${DAYS}d '+%Y-%m-%d' 2>/dev/null || echo '(see openssl output)')"
echo ""

openssl req -x509 -newkey rsa:2048 \
  -keyout "${KEY_FILE}" \
  -out    "${CRT_FILE}" \
  -days   "${DAYS}" \
  -nodes \
  -subj "/CN=${CN}/O=Lenskart IdP/OU=Identity/C=IN" \
  -addext "subjectAltName=IP:${CN},DNS:${CN}" 2>/dev/null || \
openssl req -x509 -newkey rsa:2048 \
  -keyout "${KEY_FILE}" \
  -out    "${CRT_FILE}" \
  -days   "${DAYS}" \
  -nodes \
  -subj "/CN=${CN}/O=Lenskart IdP/OU=Identity/C=IN"

echo "==> Generated:"
echo "    Key:  ${KEY_FILE}"
echo "    Cert: ${CRT_FILE}"
echo ""

# Print fingerprint so admins can verify
echo "==> Certificate fingerprint (SHA-256):"
openssl x509 -in "${CRT_FILE}" -noout -fingerprint -sha256 2>/dev/null || true
echo ""
echo "==> Validity:"
openssl x509 -in "${CRT_FILE}" -noout -dates 2>/dev/null || true
echo ""

# ---------------------------------------------------------------------------
# Patch .env — inline the PEM values as \n-escaped single-line strings
# ---------------------------------------------------------------------------
ENV_FILE="${REPO_ROOT}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "WARN: ${ENV_FILE} not found — skipping auto-patch. Copy values manually:"
else
  KEY_LINE="SAML_IDP_PRIVATE_KEY_PEM=$(awk '{printf "%s\\n", $0}' "${KEY_FILE}")"
  CRT_LINE="SAML_IDP_CERT_PEM=$(awk '{printf "%s\\n", $0}' "${CRT_FILE}")"

  # Remove old values (commented or active) and append fresh ones
  grep -v '^#\?SAML_IDP_PRIVATE_KEY_PEM=' "${ENV_FILE}" | \
  grep -v '^#\?SAML_IDP_CERT_PEM='        > /tmp/.env.patched || true

  {
    echo ""
    echo "# SAML IdP keys — generated $(date '+%Y-%m-%d') — valid 3 years"
    echo "${KEY_LINE}"
    echo "${CRT_LINE}"
  } >> /tmp/.env.patched

  cp "${ENV_FILE}" "${ENV_FILE}.bak"
  mv /tmp/.env.patched "${ENV_FILE}"
  echo "==> .env patched — old values backed up to ${ENV_FILE}.bak"
  echo ""
fi

# Always print the export lines so the operator can paste them manually if needed
echo "==> Manual .env values (if auto-patch didn't run):"
echo ""
echo "SAML_IDP_PRIVATE_KEY_PEM=$(awk '{printf "%s\\n", $0}' "${KEY_FILE}")"
echo ""
echo "SAML_IDP_CERT_PEM=$(awk '{printf "%s\\n", $0}' "${CRT_FILE}")"
echo ""
echo "==> Done. Restart the container to load the new keys:"
echo "    bash scripts/deploy.sh"
