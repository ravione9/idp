#!/usr/bin/env bash
# Prove the IdP responds like Cloudflare expects (521 = TCP fail, not app logic).
set -euo pipefail
cd "$(dirname "$0")/.."

PUB_IP="${1:-$(curl -sf --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || curl -sf --max-time 5 https://ifconfig.me 2>/dev/null || echo '')}"

echo "=== Cloudflare origin simulation ==="
echo "521 means Cloudflare never completed TCP to origin — Express never runs."
echo ""

pass() { echo "  OK: $1"; }
fail() { echo "  FAIL: $1"; }

echo "1) Local :80 with Cloudflare Host + headers"
if curl -sf http://127.0.0.1:80/healthz \
  -H "Host: idp.lenskart.com" \
  -H "X-Forwarded-Proto: https" \
  -H "CF-Connecting-IP: 104.16.0.1" \
  -H "CF-Ray: test" >/dev/null; then
  pass "App responds to Cloudflare-style HTTP on port 80"
  curl -sf http://127.0.0.1:80/healthz \
    -H "Host: idp.lenskart.com" \
    -H "X-Forwarded-Proto: https" && echo
else
  fail "App not responding on :80"
fi

echo ""
echo "2) Public IP :80 (what internet / Cloudflare must reach)"
if [[ -n "$PUB_IP" ]]; then
  if curl -sf "http://${PUB_IP}/healthz" -H "Host: idp.lenskart.com" >/dev/null; then
    pass "Origin reachable at http://${PUB_IP}/healthz"
  else
    fail "Cannot reach http://${PUB_IP}/healthz — SG/ufw/DNS issue"
  fi

  echo ""
  echo "3) Public IP :443 (only matters if Cloudflare SSL = Full / Strict)"
  CODE=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://${PUB_IP}/healthz" 2>/dev/null || echo "000")
  echo "  HTTPS :443 → HTTP $CODE (app logs say HTTP-only; use Cloudflare SSL Flexible)"
  if [[ "$CODE" == "200" ]]; then
    pass "HTTPS origin works"
  else
    echo "  WARN: Cloudflare SSL must be Flexible (CF → origin HTTP :80), not Full"
  fi
else
  echo "  (skip — could not detect public IP)"
fi

echo ""
echo "4) Via Cloudflare edge"
CF_CODE=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 https://idp.lenskart.com/healthz 2>/dev/null || echo "000")
echo "  https://idp.lenskart.com/healthz → HTTP $CF_CODE"
if [[ "$CF_CODE" == "200" ]]; then
  pass "Cloudflare → origin working"
elif [[ "$CF_CODE" == "521" ]]; then
  echo ""
  echo "  521 with local/public :80 OK → Cloudflare is NOT hitting this server on :80."
  echo "  Check Cloudflare dashboard:"
  echo "    DNS A idp → ${PUB_IP:-3.6.124.122} (Proxied ON)"
  echo "    SSL/TLS → Flexible (not Full)"
  echo "  Optional test: grey-cloud the A record 5 min — if http://idp.lenskart.com works,"
  echo "  origin IP is correct and orange-cloud SSL/port config is the problem."
else
  echo "  HTTP $CF_CODE — see Cloudflare / WAF rules"
fi
