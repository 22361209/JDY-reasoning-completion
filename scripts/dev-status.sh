#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT_DIR/verification/logs"
BACKEND_HEALTH_URL="http://127.0.0.1:8080/actuator/health"
FRONTEND_URL="http://127.0.0.1:5173/"

print_port() {
  local label="$1"
  local port="$2"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//' || true)"
  if [[ -n "$pids" ]]; then
    printf '%-10s port %-5s LISTEN pid=%s\n' "$label" "$port" "$pids"
  else
    printf '%-10s port %-5s not listening\n' "$label" "$port"
  fi
}

print_url() {
  local label="$1"
  local url="$2"
  if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
    printf '%-10s ready %s\n' "$label" "$url"
  else
    printf '%-10s not ready %s\n' "$label" "$url"
  fi
}

print_pid_file() {
  local label="$1"
  local pid_file="$2"
  if [[ ! -f "$pid_file" ]]; then
    printf '%-10s pid file missing\n' "$label"
    return
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ "$pid" == screen:* ]]; then
    local session="${pid#screen:}"
    if command -v screen >/dev/null 2>&1 && screen -ls 2>/dev/null | grep -q "[.]${session}[[:space:]]"; then
      printf '%-10s screen=%s alive\n' "$label" "$session"
    else
      printf '%-10s screen=%s not alive\n' "$label" "$session"
    fi
    return
  fi
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    printf '%-10s pid=%s alive\n' "$label" "$pid"
  else
    printf '%-10s pid=%s not alive\n' "$label" "${pid:-unknown}"
  fi
}

printf 'JDY dev services\n'
printf 'Root: %s\n\n' "$ROOT_DIR"

print_port "backend" 8080
print_port "frontend" 5173
printf '\n'
print_url "backend" "$BACKEND_HEALTH_URL"
print_url "frontend" "$FRONTEND_URL"
printf '\n'
print_pid_file "backend" "$LOG_DIR/backend-dev.pid"
print_pid_file "frontend" "$LOG_DIR/frontend-dev.pid"
printf '\n'

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker compose -f "$ROOT_DIR/infra/docker-compose.yml" ps
else
  printf 'docker     not available or Docker Desktop is not running\n'
fi

printf '\nLogs: %s\n' "$LOG_DIR"
