#!/usr/bin/env bash
# Install Docker Compose v2 plugin (fixes ContainerConfig bug with docker-compose v1.29)
set -euo pipefail

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) echo "Unsupported arch: $ARCH"; exit 1 ;;
esac

PLUGIN_DIR="${DOCKER_CLI_PLUGIN_DIR:-/usr/local/lib/docker/cli-plugins}"
mkdir -p "$PLUGIN_DIR"
DEST="${PLUGIN_DIR}/docker-compose"

# v2.24.9 was removed from GitHub releases — pin a known-good tag, then try /latest.
PINS=( "${COMPOSE_VERSION:-v2.36.1}" latest )
if [[ -n "${COMPOSE_VERSION:-}" && "${COMPOSE_VERSION}" != "latest" ]]; then
  PINS=( "${COMPOSE_VERSION}" latest )
fi

download_ok=0
for ver in "${PINS[@]}"; do
  if [[ "$ver" == "latest" ]]; then
    URL="https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH}"
    label="latest"
  else
    URL="https://github.com/docker/compose/releases/download/${ver}/docker-compose-linux-${ARCH}"
    label="$ver"
  fi
  echo "==> Downloading Docker Compose ${label} (${ARCH})..."
  if curl -fsSL "$URL" -o "$DEST"; then
    download_ok=1
    break
  fi
  echo "    WARN: download failed for ${label}"
done

if [[ "$download_ok" -ne 1 ]]; then
  echo "ERROR: Could not download Docker Compose plugin." >&2
  echo "  Try: COMPOSE_VERSION=v2.36.1 sudo bash scripts/install-compose-v2.sh" >&2
  exit 1
fi

chmod +x "$DEST"

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: Plugin installed at ${DEST} but 'docker compose version' failed." >&2
  echo "  Ensure Docker CLI loads plugins from ${PLUGIN_DIR}" >&2
  exit 1
fi

echo "==> Installed:"
docker compose version
echo ""
echo "Use from /opt/idp:"
echo "    docker compose -f docker-compose.dev.yml up -d --build"
