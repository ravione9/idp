#!/usr/bin/env bash
# Install Docker Compose v2 plugin (fixes ContainerConfig bug with docker-compose v1.29)
set -euo pipefail

COMPOSE_VERSION="${COMPOSE_VERSION:-v2.24.9}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

PLUGIN_DIR="/usr/local/lib/docker/cli-plugins"
mkdir -p "$PLUGIN_DIR"

URL="https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${ARCH}"

echo "==> Downloading Docker Compose ${COMPOSE_VERSION} (${ARCH})..."
curl -fsSL "$URL" -o "${PLUGIN_DIR}/docker-compose"
chmod +x "${PLUGIN_DIR}/docker-compose"

echo "==> Installed. Test with:"
echo "    docker compose version"
docker compose version

echo ""
echo "Use from /opt/idp:"
echo "    docker compose -f docker-compose.dev.yml up -d --build"
