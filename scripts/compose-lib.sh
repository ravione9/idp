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

idp_rm_stale_api() {
  echo "==> Removing stale API containers (ContainerConfig workaround)..."
  "${IDP_COMPOSE[@]}" stop lilg-api 2>/dev/null || true
  docker rm -f idp-api lilg-api 2>/dev/null || true
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
