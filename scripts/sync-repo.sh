#!/usr/bin/env bash
# Sync /opt/idp to origin — discards accidental local edits to tracked files.
# .env is gitignored and is NOT touched.
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="${IDP_GIT_BRANCH:-main}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: not a git repository ($(pwd))" >&2
  exit 1
fi

if git status --porcelain 2>/dev/null | grep -q .; then
  echo "==> Dirty working tree detected — resetting tracked files to origin/${BRANCH}:"
  git status -s || true
fi

git fetch origin "${BRANCH}"
git reset --hard "origin/${BRANCH}"

echo "==> Repo at $(git rev-parse --short HEAD) ($(git log -1 --format='%s'))"
