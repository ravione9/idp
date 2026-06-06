#!/usr/bin/env bash
# Diagnostics when https://idp.lenskart.com is down (Cloudflare 502/503/403).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Public URL (via Cloudflare) ==="
curl -sI "https://idp.lenskart.com/healthz" 2>&1 | head -15 || echo "curl failed"

echo ""
echo "=== Origin :80 (what Cloudflare hits) ==="
curl -sf http://127.0.0.1:80/healthz && echo || echo "FAIL — Cloudflare cannot reach origin on port 80"

echo ""
echo "=== Origin :8080 (local) ==="
curl -sf http://127.0.0.1:8080/healthz && echo || echo "FAIL — API container not healthy"

echo ""
echo "=== Listening ports ==="
ss -tlnp 2>/dev/null | grep -E ':80 |:8080 ' || netstat -tlnp 2>/dev/null | grep -E ':80 |:8080 ' || echo "ports 80/8080 not listening"

echo ""
echo "=== PUBLIC_BASE_URL / TRUST_PROXY ==="
grep -E '^(PUBLIC_BASE_URL|TRUST_PROXY|COOKIE_SECURE)=' .env 2>/dev/null || echo ".env missing or keys not set"

echo ""
echo "=== Containers ==="
docker ps -a --filter name=idp- --filter name=lilg- 2>/dev/null || docker ps -a

echo ""
echo "=== API logs ==="
docker logs idp-api --tail 50 2>&1 || docker logs lilg-api --tail 50 2>&1 || true

echo ""
echo "=== Origin IP (Cloudflare DNS A record must match public IP) ==="
PRIV_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
PUB_IP=""
if curl -sf --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null | grep -qE '^[0-9]'; then
  PUB_IP=$(curl -sf --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4)
elif curl -sf --max-time 5 https://ifconfig.me 2>/dev/null | grep -qE '^[0-9]'; then
  PUB_IP=$(curl -sf --max-time 5 https://ifconfig.me)
fi
echo "  Private IP (this host): ${PRIV_IP:-unknown}"
echo "  Public IP (internet):   ${PUB_IP:-NONE — instance may have no Elastic IP}"
if [[ -z "$PUB_IP" ]]; then
  echo "  FAIL — Cloudflare cannot reach a private-only EC2 (172.x). Fix one of:"
  echo "    • Attach Elastic IP + Cloudflare A record → that EIP + SG allow TCP 80"
  echo "    • Put ALB/NLB in front with public listener → 80 → this instance"
  echo "    • Use Cloudflare Tunnel (cloudflared) — no inbound port 80 on AWS"
else
  echo "  Cloudflare dashboard → DNS → idp.lenskart.com A record must be: $PUB_IP (Proxied ON)"
  echo "  Test from another network: curl -sf http://$PUB_IP/healthz"
fi

echo ""
echo "=== AWS Security Group / host firewall ==="
echo "  Inbound TCP 80 required from 0.0.0.0/0 (or https://www.cloudflare.com/ips/)"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q active; then
  echo "  ufw (host firewall — blocks traffic even when AWS SG allows port 80):"
  if ufw status 2>/dev/null | grep -qE '80/tcp.*ALLOW'; then
    ufw status | grep -E '80|8080'
  else
    echo "    *** BLOCKED: port 80 not in ufw ALLOW list ***"
    echo "    FIX:  sudo ufw allow 80/tcp && sudo ufw reload"
    echo "    Then: curl -sI https://idp.lenskart.com/healthz"
  fi
fi

echo ""
echo "=== .env duplicates ==="
if [[ -f .env ]] && [[ $(grep -c '^COOKIE_SECURE=' .env 2>/dev/null || echo 0) -gt 1 ]]; then
  echo "WARN: .env has multiple COOKIE_SECURE= lines — remove COOKIE_SECURE=false, keep COOKIE_SECURE=true"
fi

echo ""
echo "=== Common fixes ==="
echo "  Local :80 OK but Cloudflare 521 → networking (not the app):"
echo "    1. Cloudflare DNS A record → this server's PUBLIC IP (not 172.x private)"
echo "    2. AWS Security Group → inbound TCP 80"
echo "    3. Instance needs Elastic IP or ALB — private subnet alone won't work"
echo "  Local :80 FAIL → bash scripts/fix-cloudflare-521.sh"
echo "  403 from Cloudflare → WAF/Bot Fight blocking — add bypass for /healthz /login"
echo "  SSL error → Cloudflare SSL mode: Flexible (origin is HTTP on :80)"
