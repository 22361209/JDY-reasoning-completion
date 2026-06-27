#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf '[dev-down] %s\n' "$*"
}

kill_port() {
  local port="$1"
  local label="$2"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//' || true)"
  if [[ -z "$pids" ]]; then
    log "$label is not listening on $port"
    return
  fi

  log "stopping $label on $port: $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
}

kill_port 5173 "frontend"
kill_port 8080 "backend"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  log "stopping postgres/redis compose services"
  docker compose -f "$ROOT_DIR/infra/docker-compose.yml" stop
else
  log "docker not available or Docker Desktop is not running; skipped compose stop"
fi

log "done"
