#!/usr/bin/env bash
# Unified compose entry point for pam-2 — always use this instead of raw docker-compose.
#
#   ./dev-up.sh up -d --build lilg-api
#   bash scripts/compose.sh up -d --build
#   bash scripts/restart-api.sh
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=compose-lib.sh
source "${SCRIPT_DIR}/compose-lib.sh"
cd "$(_idp_repo_root)"

idp_compose_init

if idp_compose_needs_rm_before_up "$@"; then
  idp_rm_stale_api
fi

exec "${IDP_COMPOSE[@]}" "$@"
