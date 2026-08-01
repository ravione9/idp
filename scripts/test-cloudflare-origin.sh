#!/usr/bin/env bash
# Prove the IdP responds like Cloudflare expects (521 = TCP fail, not app logic).
set -euo pipefail
cd "$(dirname "$0")/.."

HOSTNAME="${IDP_ORIGIN_HOST:-idp-preprod.lenskart.com}"
PUBLIC_URL="https://${HOSTNAME}"
PUB_IP="${1:-$(curl -sf --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || curl -sf --max-time 5 https://ifconfig.me 2>/dev/null || echo '')}"

echo "=== Cloudflare origin simulation ==="
echo "521 means Cloudflare never completed TCP to origin — Express never runs."
echo "Host: ${HOSTNAME}"
echo ""

pass() { echo "  OK: $1"; }
fail() { echo "  FAIL: $1"; }

echo "1) Local :80 with Cloudflare Host + headers"
if curl -sf http://127.0.0.1:80/healthz \
  -H "Host: ${HOSTNAME}" \
  -H "X-Forwarded-Proto: https" \
  -H "CF-Connecting-IP: 104.16.0.1" \
  -H "CF-Ray: test" >/dev/null; then
  pass "App responds to Cloudflare-style HTTP on port 80"
  curl -sf http://127.0.0.1:80/healthz \
    -H "Host: ${HOSTNAME}" \
    -H "X-Forwarded-Proto: https" && echo
else
  fail "App not responding on :80"
fi

echo ""
echo "2) Public IP :80 (what internet / Cloudflare must reach)"
if [[ -n "$PUB_IP" ]]; then
  if curl -sf "http://${PUB_IP}/healthz" -H "Host: ${HOSTNAME}" >/dev/null; then
    pass "Origin reachable at http://${PUB_IP}/healthz"
  else
    fail "Cannot reach http://${PUB_IP}/healthz — SG/ufw/DNS issue"
  fi

  echo ""
  echo "3) Local :443 / :8443 (container HTTPS — needs origin cert in DB)"
  L443=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://127.0.0.1/healthz" 2>/dev/null || echo "000")
  L8443=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://127.0.0.1:8443/healthz" 2>/dev/null || echo "000")
  echo "  https://127.0.0.1:443/healthz   → HTTP $L443"
  echo "  https://127.0.0.1:8443/healthz → HTTP $L8443"
  if [[ "$L443" == "200" || "$L8443" == "200" ]]; then
    pass "Origin HTTPS responding locally"
  else
    echo "  WARN: HTTPS not configured — logs show 'Portal HTTPS not configured'"
    echo "        Use Cloudflare SSL Flexible (:80), or upload Origin Certificate (see below)"
  fi

  echo ""
  echo "4) Public IP :443 (Cloudflare Full / Strict hits this, not :80)"
  H443=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://${PUB_IP}/healthz" 2>/dev/null || echo "000")
  P443=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://${PUB_IP}:443/healthz" 2>/dev/null || echo "000")
  echo "  https://${PUB_IP}/healthz  → HTTP $H443"
  echo "  http://${PUB_IP}:443/healthz → HTTP $P443"
  if [[ "$H443" == "200" ]]; then
    pass "Public HTTPS :443 works — Cloudflare Full SSL OK"
  elif [[ "$H443" == "502" || "$H443" == "000" ]]; then
    echo "  FAIL: :443 returns $H443 — docker maps 443→8443 but app has no TLS cert"
    echo "  Fix A (quick): Cloudflare SSL/TLS → Flexible (uses :80 only)"
    echo "  Fix B (Full SSL): Cloudflare Origin Certificate → upload in IdP admin → enable HTTPS"
    echo "        + sudo ufw allow 443/tcp && AWS SG inbound TCP 443"
  fi

  if command -v openssl >/dev/null 2>&1; then
    echo ""
    echo "5) TLS handshake on :443"
    if openssl s_client -connect "${PUB_IP}:443" -servername "${HOSTNAME}" </dev/null 2>/dev/null | grep -q "BEGIN CERTIFICATE"; then
      pass "TLS certificate presented on :443"
      openssl s_client -connect "${PUB_IP}:443" -servername "${HOSTNAME}" </dev/null 2>/dev/null \
        | openssl x509 -noout -subject -dates 2>/dev/null || true
    else
      echo "  FAIL: no valid TLS on :443 (expected until Origin Certificate is installed)"
    fi
  fi
else
  echo "  (skip — could not detect public IP)"
fi

echo ""
echo "6) Via Cloudflare edge (orange cloud)"
CF_CODE=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "${PUBLIC_URL}/healthz" 2>/dev/null || echo "000")
echo "  ${PUBLIC_URL}/healthz → HTTP $CF_CODE"
if [[ "$CF_CODE" == "200" ]]; then
  pass "Cloudflare → origin working"
elif [[ "$CF_CODE" == "521" ]]; then
  echo ""
  echo "  521 with local/public :80 OK → Cloudflare is NOT hitting this server on :80."
  echo "  Check Cloudflare dashboard:"
  echo "    DNS A ${HOSTNAME} → ${PUB_IP:-<EC2 EIP>} (Proxied ON)"
  echo "    SSL/TLS → Flexible (not Full)"
  echo "  Optional test: grey-cloud the A record 5 min — if http://${HOSTNAME} works,"
  echo "  origin IP is correct and orange-cloud SSL/port config is the problem."
else
  echo "  HTTP $CF_CODE — see Cloudflare / WAF rules"
fi
