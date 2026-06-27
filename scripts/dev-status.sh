#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

printf 'JDY dev services\n'
printf 'Root: %s\n\n' "$ROOT_DIR"

print_port "backend" 8080
print_port "frontend" 5173
printf '\n'
print_url "backend" "$BACKEND_HEALTH_URL"
print_url "frontend" "$FRONTEND_URL"
printf '\n'

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker compose -f "$ROOT_DIR/infra/docker-compose.yml" ps
else
  printf 'docker     not available or Docker Desktop is not running\n'
fi

printf '\nLogs: %s\n' "$ROOT_DIR/verification/logs"
