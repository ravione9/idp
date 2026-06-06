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
echo "=== Common fixes ==="
echo "  503 from Cloudflare → origin port 80 not open or API crash-loop"
echo "    bash scripts/deploy-prod.sh"
echo "  403 from Cloudflare → WAF/Bot Fight blocking — add bypass for /healthz /login"
echo "  SSL error → Cloudflare SSL mode: Flexible (origin is HTTP on :80)"
