#!/usr/bin/env bash
# pam-2 standard deploy: sync git (hard reset) + rebuild/restart API.
#
# Use this instead of bare `git pull` — the dev server must never keep local
# edits to tracked files (manual script patches cause merge conflicts forever).
#
#   bash scripts/deploy.sh
#
# On a **new server** (first install), run once:
#   bash scripts/fix-and-start.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/sync-repo.sh

# First-time: no MySQL container → full stack bootstrap
if ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qE '^(idp-mysql|lilg-mysql)$'; then
  echo "==> New install detected — starting full stack (MySQL + Redis + API)..."
  exec bash scripts/fix-and-start.sh
fi

exec bash scripts/restart-api.sh
