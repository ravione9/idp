#!/usr/bin/env bash
# Check whether a user can complete SP-initiated SAML SSO (e.g. Zoho Mail login).
# Safe to re-run. Read-only against MySQL.
#
# Usage:
#   bash scripts/check-user-sso.sh test.a@itinfralenskart.com
#   bash scripts/check-user-sso.sh test.a@itinfralenskart.com zoho-mail
set -euo pipefail
cd "$(dirname "$0")/.."

EMAIL="${1:-test.a@itinfralenskart.com}"
APP_SLUG="${2:-zoho-mail}"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source <(grep -E '^(DB_PASSWORD|DB_USER|DB_NAME|SAML_IDP_BASE_URL|SAML_IDP_PRIVATE_KEY_PEM|SAML_IDP_CERT_PEM)=' .env | sed 's/\r$//')
fi
DB_USER="${DB_USER:-lilg_app}"
DB_PASS="${DB_PASSWORD:-s3cr3t_change_me}"
DB_NAME="${DB_NAME:-lilg}"

MYSQL_C=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^(idp-mysql|lilg-mysql)$' | head -1 || true)
if [[ -z "$MYSQL_C" ]]; then
  echo "ERROR: idp-mysql / lilg-mysql container not running." >&2
  exit 1
fi

mysql_q() {
  docker exec -i "$MYSQL_C" mysql -N -B -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "$1" 2>/dev/null
}

pass() { echo "  OK   $*"; }
fail() { echo "  FAIL $*"; FAIL=1; }
warn() { echo "  WARN $*"; }

FAIL=0

echo "=== SSO readiness: $EMAIL → $APP_SLUG ==="
echo ""

echo "-- Employee record --"
EMP_ROW=$(mysql_q "
SELECT CONCAT(emp_id, '\t', COALESCE(full_name,''), '\t', COALESCE(ilg_state,''), '\t', COALESCE(hrms_status,''), '\t', COALESCE(role,''))
FROM employees
WHERE email_corp = '${EMAIL}'
LIMIT 1;
" || true)

if [[ -z "$EMP_ROW" ]]; then
  fail "No employees row for email_corp = $EMAIL"
  EMP_ID=""
else
  EMP_ID=$(echo "$EMP_ROW" | cut -f1)
  ILG_STATE=$(echo "$EMP_ROW" | cut -f3)
  HRMS=$(echo "$EMP_ROW" | cut -f4)
  pass "Employee $EMP_ID — ilg_state=$ILG_STATE hrms_status=$HRMS"
  case "$ILG_STATE" in
    ACTIVE|REACTIVATED) pass "ilg_state allows SAML assertions" ;;
    *) fail "ilg_state=$ILG_STATE — SAML blocked (need ACTIVE or REACTIVATED)" ;;
  esac
  if [[ "$HRMS" == "ACTIVE" ]]; then
    pass "hrms_status=ACTIVE"
  else
    fail "hrms_status=$HRMS — SAML blocked (need ACTIVE)"
  fi
fi

echo ""
echo "-- Local login account --"
if [[ -n "$EMP_ID" ]]; then
  LA_ROW=$(mysql_q "
SELECT CONCAT(la.email, '\t', la.active, '\t', la.role)
FROM local_accounts la
WHERE la.emp_id = '${EMP_ID}' AND la.active = 1
LIMIT 1;
" || true)
  if [[ -z "$LA_ROW" ]]; then
    fail "No active local_accounts row for emp_id=$EMP_ID (cannot sign in with password at /login)"
  else
    pass "Local account: $(echo "$LA_ROW" | cut -f1) role=$(echo "$LA_ROW" | cut -f3)"
  fi
else
  LA_EMAIL=$(mysql_q "
SELECT la.email FROM local_accounts la WHERE la.email = '${EMAIL}' AND la.active = 1 LIMIT 1;
" || true)
  if [[ -n "$LA_EMAIL" ]]; then
    warn "Local account exists for $LA_EMAIL but employee row is missing — login may fail after auth"
  else
    fail "No local_accounts row for $EMAIL"
  fi
fi

echo ""
echo "-- Application ($APP_SLUG) --"
APP_ROW=$(mysql_q "
SELECT CONCAT(a.id, '\t', a.slug, '\t', a.visibility, '\t', a.active)
FROM applications a
WHERE a.slug IN ('${APP_SLUG}', 'zoho_mail', 'zoho-mail')
  AND a.active = 1
ORDER BY CASE a.slug WHEN '${APP_SLUG}' THEN 0 WHEN 'zoho-mail' THEN 1 ELSE 2 END
LIMIT 1;
" || true)

if [[ -z "$APP_ROW" ]]; then
  fail "No active applications row for slug $APP_SLUG (register SAML app first)"
  APP_ID=""
else
  APP_ID=$(echo "$APP_ROW" | cut -f1)
  APP_SLUG_DB=$(echo "$APP_ROW" | cut -f2)
  VIS=$(echo "$APP_ROW" | cut -f3)
  pass "Application id=$APP_ID slug=$APP_SLUG_DB visibility=$VIS"
  if [[ "$VIS" == "RESTRICTED" ]]; then
    pass "RESTRICTED — explicit Application Access Policy grant required"
  fi
fi

SP_RULE=$(mysql_q "
SELECT COALESCE(entitlement_rule, '{}')
FROM saml_service_providers
WHERE slug IN ('${APP_SLUG}', 'zoho_mail', 'zoho-mail') AND active = 1
ORDER BY CASE slug WHEN '${APP_SLUG}' THEN 0 WHEN 'zoho-mail' THEN 1 ELSE 2 END
LIMIT 1;
" || true)
if [[ -z "$SP_RULE" ]]; then
  fail "No active saml_service_providers row for $APP_SLUG"
else
  if echo "$SP_RULE" | grep -q '"all_active"[[:space:]]*:[[:space:]]*false'; then
    pass "SAML entitlement_rule.all_active=false (policy grant required)"
  elif echo "$SP_RULE" | grep -q '"all_active"[[:space:]]*:[[:space:]]*true'; then
    warn "SAML entitlement_rule.all_active=true — all active employees may SSO without policy grant"
  else
    pass "SAML SP registered (entitlement_rule: $SP_RULE)"
  fi
fi

echo ""
echo "-- Application Access Policy grant --"
if [[ -n "$EMP_ID" && -n "$APP_ID" ]]; then
  GRANT=$(mysql_q "
SELECT CONCAT(aaa.assignment_type, '\t', aaa.target_id)
FROM app_access_assignments aaa
WHERE aaa.app_id = '${APP_ID}' AND aaa.active = 1
  AND (
    (aaa.assignment_type = 'USER' AND aaa.target_id = '${EMP_ID}')
    OR (aaa.assignment_type = 'TAG_GROUP' AND EXISTS (
      SELECT 1 FROM tag_group_members tgm
       WHERE tgm.tag_group_id = aaa.target_id AND tgm.emp_id = '${EMP_ID}'
    ))
    OR (aaa.assignment_type = 'GROUP' AND EXISTS (
      SELECT 1 FROM group_members gm
       WHERE gm.group_id = aaa.target_id AND gm.emp_id = '${EMP_ID}'
    ))
  )
LIMIT 1;
" || true)
  if [[ -n "$GRANT" ]]; then
    pass "Policy grant via $(echo "$GRANT" | cut -f1) → $(echo "$GRANT" | cut -f2)"
  else
    fail "No app_access_assignments grant for emp_id=$EMP_ID on $APP_SLUG_DB"
    echo "       Fix: Admin → Application Access Policy → Assign Application Access"
    echo "            Application: Zoho Mail | Type: User-based | Employee ID: $EMP_ID"
  fi
else
  warn "Skipped policy grant check (missing employee or application id)"
fi

echo ""
echo "-- SAML IdP config (.env) --"
if [[ -n "${SAML_IDP_BASE_URL:-}" ]]; then
  pass "SAML_IDP_BASE_URL=$SAML_IDP_BASE_URL"
else
  fail "SAML_IDP_BASE_URL not set in .env"
fi
if [[ -n "${SAML_IDP_PRIVATE_KEY_PEM:-}" && -n "${SAML_IDP_CERT_PEM:-}" ]]; then
  pass "SAML signing keys present in .env"
elif docker exec idp-api test -f /app/data/saml/idp.key 2>/dev/null; then
  pass "SAML signing keys on volume /app/data/saml"
else
  fail "SAML signing keys missing — run scripts/gen-saml-dev-keys.sh or set PEM vars"
fi

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "RESULT: User should be able to SSO to $APP_SLUG after signing in at /login"
  echo "Test: open Zoho login → IdP /login → sign in as $EMAIL → auto-return to Zoho"
else
  echo "RESULT: Fix FAIL items above, then retry Zoho login"
  exit 1
fi
