# Shared Docker Compose helpers for pam-2 (source from other scripts; do not execute directly).
# Prefers `docker compose` v2; falls back to legacy docker-compose v1.29.

_idp_repo_root() {
  (cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
}

idp_compose_init() {
  COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.dev.yml}"
  if docker compose version >/dev/null 2>&1; then
    IDP_COMPOSE=(docker compose -f "$COMPOSE_FILE")
    IDP_COMPOSE_V2=1
  elif command -v docker-compose >/dev/null 2>&1; then
    IDP_COMPOSE=(docker-compose -f "$COMPOSE_FILE")
    IDP_COMPOSE_V2=0
  else
    echo "ERROR: Neither 'docker compose' nor 'docker-compose' found." >&2
    echo "  sudo bash scripts/install-compose-v2.sh" >&2
    exit 1
  fi
}

# Install Compose v2 plugin when only legacy docker-compose v1.29 is present.
idp_ensure_compose_v2() {
  if docker compose version >/dev/null 2>&1; then
    return 0
  fi
  echo "==> Docker Compose v2 not found — installing plugin (fixes ContainerConfig bug)..."
  bash "$(dirname "${BASH_SOURCE[0]}")/install-compose-v2.sh"
  idp_compose_init
}

idp_rm_stale_api() {
  echo "==> Removing stale API containers (ContainerConfig workaround)..."
  "${IDP_COMPOSE[@]}" stop lilg-api 2>/dev/null || true
  # Remove from compose project (clears ghost names like 504b9cb60f54_idp-api)
  "${IDP_COMPOSE[@]}" rm -f -s lilg-api 2>/dev/null || true
  docker rm -f idp-api lilg-api 2>/dev/null || true
  # Any container whose name contains idp-api or lilg-api (compose v1 debris)
  local id
  while read -r id; do
    [[ -n "$id" ]] && docker rm -f "$id" 2>/dev/null || true
  done < <(docker ps -aq --filter "name=idp-api" 2>/dev/null || true)
  while read -r id; do
    [[ -n "$id" ]] && docker rm -f "$id" 2>/dev/null || true
  done < <(docker ps -aq --filter "name=lilg-api" 2>/dev/null || true)
}

idp_compose_start_api() {
  idp_rm_stale_api
  echo "==> Starting lilg-api..."
  if [[ ${IDP_COMPOSE_V2:-0} -eq 1 ]]; then
    "${IDP_COMPOSE[@]}" up -d --no-deps lilg-api
  else
    # v1.29: never use `up` after `build` — use create+start to avoid recreate path
    "${IDP_COMPOSE[@]}" create lilg-api
    docker start idp-api
  fi
}

# docker-compose v1.29 crashes with KeyError: ContainerConfig when recreating
# an existing container after --build. Removing the container first avoids that path.
idp_compose_needs_rm_before_up() {
  [[ "${1:-}" == "up" ]] || return 1
  case " $* " in
    *" --build "*|*" --build"|*" --force-recreate "*|*" lilg-api"*)
      return 0
      ;;
  esac
  return 1
}
