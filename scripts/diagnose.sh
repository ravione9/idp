#!/usr/bin/env bash
# Quick diagnostics when idp-api is unhealthy
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== .env exists? ==="
if [[ -f .env ]]; then
  echo "yes"
  grep -E '^(SESSION_SECRET|DB_HOST|REDIS_URL|SQS_)=' .env | sed 's/=.*/=***/' || true
else
  echo "NO — run: cp env.dev.example .env && nano .env"
fi

echo ""
echo "=== Container status ==="
docker-compose -f docker-compose.dev.yml ps 2>/dev/null || docker ps -a --filter name=idp-

echo ""
echo "=== idp-api logs (last 80 lines) ==="
docker logs idp-api --tail 80 2>&1 || true

echo ""
echo "=== curl healthz ==="
curl -sf http://127.0.0.1:8080/healthz && echo || echo "healthz FAILED"

echo ""
echo "=== curl readyz ==="
curl -sf http://127.0.0.1:8080/readyz && echo || echo "readyz FAILED (DB/Redis may still be starting)"

echo ""
echo "=== Port 8080 listening? ==="
ss -tlnp 2>/dev/null | grep ':8080' || netstat -tlnp 2>/dev/null | grep ':8080' || echo "nothing on 8080"

echo ""
echo "=== MASTER_ADMIN in .env? ==="
grep -E '^MASTER_ADMIN_' .env 2>/dev/null | sed 's/PASSWORD=.*/PASSWORD=***/' || echo "not set"

echo ""
echo "=== If idp-api missing or restarting, run: ==="
echo "  sudo bash scripts/fix-and-start.sh"
