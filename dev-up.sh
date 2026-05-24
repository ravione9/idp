#!/usr/bin/env bash
# pam-2 compose wrapper — prefer this over raw docker-compose (avoids ContainerConfig bug).
set -euo pipefail
exec "$(dirname "$0")/scripts/compose.sh" "$@"
