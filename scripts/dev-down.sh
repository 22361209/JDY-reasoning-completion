#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/verification/logs"
BACKEND_PID_FILE="$LOG_DIR/backend-dev.pid"
FRONTEND_PID_FILE="$LOG_DIR/frontend-dev.pid"
BACKEND_SESSION="jdy-erp-backend"
FRONTEND_SESSION="jdy-erp-frontend"

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

kill_pid_file() {
  local pid_file="$1"
  local label="$2"
  [[ -f "$pid_file" ]] || return 0
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    log "stopping $label pid from $pid_file: $pid"
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

kill_screen_session() {
  local session="$1"
  if command -v screen >/dev/null 2>&1 && screen -ls 2>/dev/null | grep -q "[.]${session}[[:space:]]"; then
    log "stopping screen session $session"
    screen -S "$session" -X quit >/dev/null 2>&1 || true
  fi
}

kill_screen_session "$FRONTEND_SESSION"
kill_screen_session "$BACKEND_SESSION"
kill_pid_file "$FRONTEND_PID_FILE" "frontend"
kill_pid_file "$BACKEND_PID_FILE" "backend"
kill_port 5173 "frontend"
kill_port 8080 "backend"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  log "stopping postgres/redis compose services"
  docker compose -f "$ROOT_DIR/infra/docker-compose.yml" stop
else
  log "docker not available or Docker Desktop is not running; skipped compose stop"
fi

log "done"
