#!/usr/bin/env bash
# One-shot fix for pam-2: ContainerConfig bug, missing .env, stale containers, DB migration.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=compose-lib.sh
source "$(dirname "$0")/compose-lib.sh"
idp_ensure_compose_v2
idp_compose_init
echo "==> [1/6] Ensure .env exists with required keys..."
if [[ ! -f .env ]]; then
  cp env.dev.example .env
  echo "    Created .env from env.dev.example"
fi

# Load DB / MySQL passwords from .env for later steps
set -a
# shellcheck disable=SC1091
source <(grep -E '^(DB_PASSWORD|MYSQL_ROOT_PASSWORD|MYSQL_PASSWORD)=' .env | sed 's/\r$//' || true)
set +a
DB_PASS="${DB_PASSWORD:-s3cr3t_change_me}"
MYSQL_ROOT_PASS="${MYSQL_ROOT_PASSWORD:-rootpassword}"

# Append master admin block if missing (safe — does not overwrite existing file)
if ! grep -q '^MASTER_ADMIN_EMAIL=' .env 2>/dev/null; then
  cat >> .env <<'EOF'

# Master administrator (auto-provisioned on startup)
MASTER_ADMIN_EMAIL=admin@lenskart.com
MASTER_ADMIN_PASSWORD=ChangeMe_Admin123!
MASTER_ADMIN_FULL_NAME=LILG Master Administrator
EOF
  echo "    Added MASTER_ADMIN_* to .env"
fi

# MySQL container passwords (compose no longer hardcodes these). Keep legacy defaults
# so existing mysql-data volumes continue to authenticate.
if ! grep -q '^MYSQL_ROOT_PASSWORD=' .env 2>/dev/null; then
  echo 'MYSQL_ROOT_PASSWORD=rootpassword' >> .env
  echo "    Added MYSQL_ROOT_PASSWORD to .env (legacy volume default — rotate in prod)"
fi
if ! grep -q '^MYSQL_PASSWORD=' .env 2>/dev/null; then
  _db_pass="$(grep '^DB_PASSWORD=' .env 2>/dev/null | cut -d= -f2- || true)"
  echo "MYSQL_PASSWORD=${_db_pass:-s3cr3t_change_me}" >> .env
  echo "    Added MYSQL_PASSWORD to .env"
fi

# SESSION_SECRET must be 32+ chars or API exits immediately on boot
if grep -q '^SESSION_SECRET=' .env; then
  secret_len=$(grep '^SESSION_SECRET=' .env | cut -d= -f2- | wc -c)
  if [[ "$secret_len" -lt 33 ]]; then
    echo "    WARN: SESSION_SECRET too short — patching from env.dev.example"
    grep '^SESSION_SECRET=' env.dev.example >> .env.new 2>/dev/null || true
  fi
fi

echo "==> [2/6] Stop stack and remove stale containers (fixes ContainerConfig bug)..."
"${IDP_COMPOSE[@]}" down --remove-orphans 2>/dev/null || true
docker rm -f idp-api lilg-api idp-worker idp-mysql idp-redis idp-localstack 2>/dev/null || true
docker ps -a --format '{{.Names}}' | grep -E '^idp-|_idp-|^lilg-api$' | xargs -r docker rm -f 2>/dev/null || true

echo "==> [3/6] Build and start all services..."
"${IDP_COMPOSE[@]}" up -d --build

# Re-load after possible MYSQL_* appends above
set -a
# shellcheck disable=SC1091
source <(grep -E '^(DB_PASSWORD|MYSQL_ROOT_PASSWORD|MYSQL_PASSWORD)=' .env | sed 's/\r$//' || true)
set +a
DB_PASS="${DB_PASSWORD:-s3cr3t_change_me}"
MYSQL_ROOT_PASS="${MYSQL_ROOT_PASSWORD:-rootpassword}"

echo "==> [4/6] Wait for MySQL..."
for i in $(seq 1 36); do
  if docker exec idp-mysql mysqladmin ping -h 127.0.0.1 -u root -p"${MYSQL_ROOT_PASS}" --silent 2>/dev/null; then
    echo "    MySQL is up."
    break
  fi
  sleep 5
  if [[ "$i" -eq 36 ]]; then
    echo "    ERROR: MySQL did not start. Check: docker logs idp-mysql --tail 50"
    exit 1
  fi
done

echo "==> [5/6] Apply full schema (idempotent — existing tables untouched)..."
docker exec -i idp-mysql mysql -ulilg_app -p"${DB_PASS}" lilg \
  < src/db/schema.sql 2>&1 | grep -v 'Using a password' || true
docker exec -i idp-mysql mysql -ulilg_app -p"${DB_PASS}" lilg \
  < scripts/migrate-local-accounts.sql 2>/dev/null || true

echo "==> [6/6] Wait for API (up to 3 min)..."
for i in $(seq 1 36); do
  if curl -sf http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
    echo ""
    echo "=== SUCCESS ==="
    curl -sf http://127.0.0.1:8080/healthz && echo
    curl -sf http://127.0.0.1:8080/readyz && echo || echo "readyz: still warming up"
    echo ""
    echo "Login:  http://192.168.24.254:8080/login"
    echo "Email:  admin@lenskart.com"
    echo "Pass:   ChangeMe_Admin123!"
    echo ""
    docker ps --filter name=idp-
    exit 0
  fi
  sleep 5
done

echo ""
echo "=== FAILED — API not responding ==="
echo "Container status:"
docker ps -a --filter name=idp-
echo ""
echo "API logs:"
docker logs idp-api --tail 80 2>&1 || echo "(idp-api container missing — recreate failed)"
echo ""
echo "Common fixes:"
echo "  - Config error in logs → fix .env (SESSION_SECRET 32+ chars, INTERNAL_TOKEN 16+ chars)"
echo "  - MASTER_ADMIN: set both EMAIL and PASSWORD, or remove both lines"
echo "  - Install Compose v2: sudo bash scripts/install-compose-v2.sh"
exit 1
