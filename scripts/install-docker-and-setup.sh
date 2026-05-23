#!/usr/bin/env bash
# =============================================================================
# Lenskart IdP — Install Docker + deploy single-tier dev stack
# For Ubuntu/Debian dev server (e.g. 192.168.24.254 / pam-2)
#
# Run as root:
#   curl -fsSL https://raw.githubusercontent.com/ravione9/idp/main/scripts/install-docker-and-setup.sh | bash
#
# Or from cloned repo:
#   sudo bash scripts/install-docker-and-setup.sh
# =============================================================================
set -euo pipefail

REPO_URL="${IDP_REPO_URL:-https://github.com/ravione9/idp.git}"
INSTALL_DIR="${IDP_INSTALL_DIR:-/opt/idp}"
DEV_IP="${IDP_DEV_IP:-192.168.24.254}"
COMPOSE_FILE="docker-compose.dev.yml"

log() { echo "==> $*"; }
err() { echo "ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Must be root (or docker group — but install needs root anyway)
# ---------------------------------------------------------------------------
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  err "Run as root: sudo bash $0"
fi

# ---------------------------------------------------------------------------
# OS check
# ---------------------------------------------------------------------------
if [[ -f /etc/os-release ]]; then
  # shellcheck source=/dev/null
  . /etc/os-release
  log "Detected: ${PRETTY_NAME:-unknown}"
else
  err "Unsupported OS (need /etc/os-release)"
fi

case "${ID:-}" in
  ubuntu|debian)
    PKG_UPDATE="apt-get update -qq"
    PKG_INSTALL="apt-get install -y -qq"
    ;;
  *)
    err "This script supports Ubuntu/Debian only. Install Docker manually, then run dev-up.sh"
    ;;
esac

# ---------------------------------------------------------------------------
# 1. Install Docker Engine + docker-compose v1
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine..."
  $PKG_UPDATE
  $PKG_INSTALL ca-certificates curl gnupg lsb-release git
  $PKG_INSTALL docker.io
  systemctl enable docker
  systemctl start docker
  log "Docker installed: $(docker --version)"
else
  log "Docker already installed: $(docker --version)"
  systemctl start docker 2>/dev/null || true
fi

if ! command -v docker-compose >/dev/null 2>&1; then
  log "Installing docker-compose (v1)..."
  $PKG_UPDATE
  $PKG_INSTALL docker-compose
  log "docker-compose installed: $(docker-compose --version)"
else
  log "docker-compose already installed: $(docker-compose --version)"
fi

# Verify compose works (NOT "docker compose" plugin)
docker-compose --version >/dev/null || err "docker-compose failed"

# ---------------------------------------------------------------------------
# 2. Clone or update repository
# ---------------------------------------------------------------------------
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  log "Updating ${INSTALL_DIR}..."
  git -C "${INSTALL_DIR}" pull --ff-only
else
  log "Cloning ${REPO_URL} -> ${INSTALL_DIR}..."
  mkdir -p "$(dirname "${INSTALL_DIR}")"
  git clone "${REPO_URL}" "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"

# ---------------------------------------------------------------------------
# 3. Environment file
# ---------------------------------------------------------------------------
if [[ ! -f .env ]]; then
  log "Creating .env from env.dev.example..."
  cp env.dev.example .env
  log "EDIT REQUIRED: nano ${INSTALL_DIR}/.env"
  log "  - SESSION_SECRET (64+ random chars)"
  log "  - LOCAL_BOOTSTRAP_TOKEN"
  log "  - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (optional for local login)"
else
  log ".env already exists — keeping it"
fi

# Ensure PUBLIC_BASE_URL matches dev IP if unset
if ! grep -q '^PUBLIC_BASE_URL=' .env 2>/dev/null; then
  echo "PUBLIC_BASE_URL=http://${DEV_IP}:8080" >> .env
fi

chmod +x dev-up.sh 2>/dev/null || true

# ---------------------------------------------------------------------------
# 4. Firewall (optional — ufw if present)
# ---------------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  log "Opening port 8080 in ufw..."
  ufw allow 8080/tcp comment 'Lenskart IdP' || true
fi

# ---------------------------------------------------------------------------
# 5. Build and start stack
# ---------------------------------------------------------------------------
log "Building and starting containers (this may take several minutes)..."
docker-compose -f "${COMPOSE_FILE}" up -d --build

log "Waiting for MySQL + API..."
sleep 15

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:8080/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# LocalStack SQS queues
if docker ps --format '{{.Names}}' | grep -q '^idp-localstack$'; then
  log "Creating LocalStack SQS queues..."
  docker exec idp-localstack awslocal sqs create-queue --queue-name lilg-hrms-events 2>/dev/null || true
  docker exec idp-localstack awslocal sqs create-queue --queue-name lilg-celery 2>/dev/null || true
fi

# DB migration for existing installs (safe if table exists)
if docker ps --format '{{.Names}}' | grep -q '^idp-mysql$'; then
  docker exec -i idp-mysql mysql -ulilg_app -ps3cr3t_change_me lilg \
    < scripts/migrate-local-accounts.sql 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 6. Status
# ---------------------------------------------------------------------------
echo ""
log "Container status:"
docker-compose -f "${COMPOSE_FILE}" ps

echo ""
HEALTH=$(curl -sf "http://127.0.0.1:8080/healthz" 2>/dev/null || echo "FAIL")
READY=$(curl -sf "http://127.0.0.1:8080/readyz" 2>/dev/null || echo "FAIL")

echo "healthz: ${HEALTH}"
echo "readyz:  ${READY}"
echo ""
echo "=============================================="
echo " Lenskart IdP dev setup complete"
echo "=============================================="
echo " Login:   http://${DEV_IP}:8080/login"
echo " Health:  http://${DEV_IP}:8080/healthz"
echo ""
echo " First super admin (bootstrap on login page):"
echo "   Use LOCAL_BOOTSTRAP_TOKEN from ${INSTALL_DIR}/.env"
echo ""
echo " Commands:"
echo "   cd ${INSTALL_DIR}"
echo "   docker-compose -f ${COMPOSE_FILE} logs -f lilg-api"
echo "   docker-compose -f ${COMPOSE_FILE} restart lilg-api"
echo "   ./dev-up.sh up -d --build"
echo "=============================================="
