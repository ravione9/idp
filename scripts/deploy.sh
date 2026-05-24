#!/usr/bin/env bash
# pam-2 standard deploy: sync git (hard reset) + rebuild/restart API.
#
# Use this instead of bare `git pull` — the dev server must never keep local
# edits to tracked files (manual script patches cause merge conflicts forever).
#
#   bash scripts/deploy.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/sync-repo.sh
exec bash scripts/restart-api.sh
