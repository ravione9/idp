#!/usr/bin/env bash
# =============================================================================
# Deploy LILG IdP on dev server (single tier, Docker)
# Target: 192.168.24.254 — https://github.com/ravione9/idp.git
#
# Run on the Linux dev server as root or a user in the docker group:
#   curl -fsSL .../deploy-dev.sh | bash
#   — or —
#   bash scripts/deploy-dev.sh
# =============================================================================
set -euo pipefail

REPO_URL="${IDP_REPO_URL:-https://github.com/ravione9/idp.git}"
INSTALL_DIR="${IDP_INSTALL_DIR:-/opt/idp}"
DEV_IP="${IDP_DEV_IP:-192.168.24.254}"
COMPOSE_FILE="docker-compose.dev.yml"

# Docker Compose v2 plugin OR legacy docker-compose v1 binary
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "ERROR: Neither 'docker compose' (plugin) nor 'docker-compose' found."
  echo "Install one of:"
  echo "  sudo apt install docker-compose-plugin   # recommended"
  echo "  sudo apt install docker-compose            # legacy v1"
  exit 1
fi

echo "==> Using: ${COMPOSE[*]}"
echo "==> LILG IdP dev deploy (single tier)"
echo "    Repo:  ${REPO_URL}"
echo "    Dir:   ${INSTALL_DIR}"
echo "    URL:   http://${DEV_IP}:8080"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed. Install Docker Engine first."
  exit 1
fi

if [[ -d "${INSTALL_DIR}/.git" ]]; then
  echo "==> Updating existing clone..."
  git -C "${INSTALL_DIR}" pull --ff-only
else
  echo "==> Cloning repository..."
  sudo mkdir -p "$(dirname "${INSTALL_DIR}")"
  if [[ ! -d "${INSTALL_DIR}" ]]; then
    sudo git clone "${REPO_URL}" "${INSTALL_DIR}"
  fi
  sudo chown -R "$(whoami):$(whoami)" "${INSTALL_DIR}" 2>/dev/null || true
fi

cd "${INSTALL_DIR}"

if [[ ! -f .env ]]; then
  echo "==> Creating .env from env.dev.example..."
  cp env.dev.example .env
  echo ""
  echo "IMPORTANT: Edit ${INSTALL_DIR}/.env before production use:"
  echo "  - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET"
  echo "  - SESSION_SECRET / INTERNAL_TOKEN"
  echo "  - PUBLIC_BASE_URL (http://${DEV_IP}:8080 or your dev hostname)"
  echo ""
fi

echo "==> Building and starting containers..."
"${COMPOSE[@]}" -f "${COMPOSE_FILE}" up -d --build

echo "==> Waiting for LocalStack..."
for i in $(seq 1 30); do
  if docker exec idp-localstack curl -sf http://localhost:4566/_localstack/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "==> Creating SQS queues in LocalStack..."
docker exec idp-localstack awslocal sqs create-queue --queue-name lilg-hrms-events 2>/dev/null || true
docker exec idp-localstack awslocal sqs create-queue --queue-name lilg-celery 2>/dev/null || true

echo "==> Health check..."
sleep 5
curl -sf "http://127.0.0.1:8080/healthz" && echo ""
curl -sf "http://127.0.0.1:8080/readyz" && echo "" || echo "WARN: readyz not OK yet — check logs: ${COMPOSE[*]} -f ${COMPOSE_FILE} logs -f lilg-api"

echo ""
echo "==> Deploy complete"
echo "    Health:  http://${DEV_IP}:8080/healthz"
echo "    Login:   http://${DEV_IP}:8080/auth/google"
echo "    SAML:    http://${DEV_IP}:8080/saml/metadata"
echo ""
echo "Google OAuth redirect URI (register in Google Cloud Console):"
echo "  http://${DEV_IP}:8080/auth/google/callback"
echo ""
echo "NOTE: Google may reject private IPs. If login fails, add to each client PC:"
echo "  ${DEV_IP}  idp-dev.lenskart.com"
echo "Then set PUBLIC_BASE_URL=http://idp-dev.lenskart.com:8080 in .env and redeploy."
