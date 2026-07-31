#!/usr/bin/env bash
# =============================================================================
# Generate production SAML IdP signing keys (RSA-2048, self-signed, 15 years)
# and a Vault-ready JSON payload for External Secrets / HashiCorp Vault.
#
# Does NOT patch .env (use scripts/gen-saml-dev-keys.sh for EC2/dev).
# Does NOT write into git-tracked paths by default — output is gitignored.
#
# Usage:
#   bash scripts/generate-saml-idp-keys.sh
#   bash scripts/generate-saml-idp-keys.sh /secure/out idp.lenskart.com
#   DAYS=5475 CN=idp.lenskart.com bash scripts/generate-saml-idp-keys.sh
#
# Env overrides:
#   OUT_DIR  — output directory (default: ./.saml-idp-keys)
#   CN       — certificate commonName / DNS SAN (default: idp.lenskart.com)
#   DAYS     — validity in days (default: 5475 ≈ 15 years)
#   VAULT_PATH — printed hint only (default: secret/data/lilg/prod/saml-signing)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUT_DIR="${1:-${OUT_DIR:-${REPO_ROOT}/.saml-idp-keys}}"
CN="${2:-${CN:-idp.lenskart.com}}"
DAYS="${DAYS:-5475}"
VAULT_PATH="${VAULT_PATH:-secret/data/lilg/prod/saml-signing}"

KEY_FILE="${OUT_DIR}/saml-idp.key"
CRT_FILE="${OUT_DIR}/saml-idp.crt"
JSON_FILE="${OUT_DIR}/saml-signing.vault.json"

if ! command -v openssl >/dev/null 2>&1; then
  echo "ERROR: openssl is required"
  exit 1
fi

mkdir -p "${OUT_DIR}"
chmod 700 "${OUT_DIR}"

if [[ -e "${KEY_FILE}" || -e "${CRT_FILE}" || -e "${JSON_FILE}" ]]; then
  echo "ERROR: output already exists under ${OUT_DIR}"
  echo "       Refuse to overwrite. Move/remove existing files, then re-run."
  ls -la "${OUT_DIR}"
  exit 1
fi

echo "==> Generating RSA-2048 self-signed SAML IdP certificate"
echo "    CN:         ${CN}"
echo "    Valid days: ${DAYS} (~$(( DAYS / 365 )) years)"
echo "    Out dir:    ${OUT_DIR}"
echo ""

# Prefer SAN=DNS:CN (OpenSSL 1.1.1+). Fall back without -addext on older openssl.
if openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "${KEY_FILE}" \
  -out "${CRT_FILE}" \
  -days "${DAYS}" \
  -sha256 \
  -subj "/C=IN/O=Lenskart IdP/OU=Identity/CN=${CN}" \
  -addext "subjectAltName=DNS:${CN}" \
  -addext "keyUsage=digitalSignature,keyEncipherment,nonRepudiation" \
  -addext "extendedKeyUsage=serverAuth" 2>/dev/null; then
  :
else
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "${KEY_FILE}" \
    -out "${CRT_FILE}" \
    -days "${DAYS}" \
    -sha256 \
    -subj "/C=IN/O=Lenskart IdP/OU=Identity/CN=${CN}"
fi

chmod 600 "${KEY_FILE}"
chmod 644 "${CRT_FILE}"

# Vault JSON: { privateKeyPem, certPem } — multiline PEM as JSON strings
if command -v python3 >/dev/null 2>&1; then
  python3 - "${KEY_FILE}" "${CRT_FILE}" "${JSON_FILE}" <<'PY'
import json, sys
key_path, crt_path, out_path = sys.argv[1:4]
with open(key_path, encoding="utf-8") as f:
    key = f.read()
with open(crt_path, encoding="utf-8") as f:
    crt = f.read()
payload = {"privateKeyPem": key, "certPem": crt}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2)
    f.write("\n")
PY
elif command -v jq >/dev/null 2>&1; then
  jq -n --rawfile key "${KEY_FILE}" --rawfile crt "${CRT_FILE}" \
    '{privateKeyPem: $key, certPem: $crt}' > "${JSON_FILE}"
else
  echo "ERROR: need python3 or jq to write Vault JSON"
  exit 1
fi
chmod 600 "${JSON_FILE}"

echo "==> Generated files (gitignored — do not commit):"
echo "    Key:  ${KEY_FILE}"
echo "    Cert: ${CRT_FILE}"
echo "    Vault JSON: ${JSON_FILE}"
echo ""

echo "==> Certificate details:"
openssl x509 -in "${CRT_FILE}" -noout -subject -issuer -dates
echo ""
echo "==> SHA-256 fingerprint (pin at every SP):"
openssl x509 -in "${CRT_FILE}" -noout -fingerprint -sha256
echo ""

echo "==> Next steps"
echo "    1. Store JSON in Vault at: ${VAULT_PATH}"
echo "       Example (KV v2):"
echo "         vault kv put ${VAULT_PATH#secret/data/} @${JSON_FILE}"
echo "       Or paste privateKeyPem / certPem via your Vault UI."
echo "    2. Point Helm ExternalSecret samlSecretKey at that path."
echo "    3. Set PUBLIC_BASE_URL / SAML_IDP_* to https://${CN}"
echo "    4. Re-import IdP metadata at every SP after go-live:"
echo "         https://${CN}/saml/metadata"
echo "    5. Keep an offline backup of key+cert; shred local copies when done:"
echo "         shred -u ${KEY_FILE} ${CRT_FILE} ${JSON_FILE}   # Linux"
echo ""
echo "==> Done."
