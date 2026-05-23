#!/usr/bin/env bash
# Run docker-compose v1 on dev server (no "docker compose" plugin required)
set -euo pipefail
cd "$(dirname "$0")"
exec docker-compose -f docker-compose.dev.yml "$@"
