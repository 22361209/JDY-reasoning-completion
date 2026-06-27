#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
LOG_DIR="$ROOT_DIR/verification/logs"
BACKEND_LOG="$LOG_DIR/backend-dev-live.log"
FRONTEND_LOG="$LOG_DIR/frontend-dev-live.log"
FRONTEND_URL="http://127.0.0.1:5173/"
BACKEND_HEALTH_URL="http://127.0.0.1:8080/actuator/health"

mkdir -p "$LOG_DIR"

log() {
  printf '[dev-up] %s\n' "$*"
}

port_listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts="${3:-40}"
  local delay="${4:-1}"

  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      log "$label is ready"
      return 0
    fi
    sleep "$delay"
  done

  log "$label did not become ready: $url"
  return 1
}

ensure_docker_deps() {
  if ! command -v docker >/dev/null 2>&1; then
    log "docker command not found. Please open Docker Desktop first."
    exit 1
  fi

  log "starting postgres/redis if needed"
  docker compose -f "$ROOT_DIR/infra/docker-compose.yml" up -d
}

start_backend() {
  if port_listening 8080; then
    log "backend already listening on 8080"
    return
  fi

  local java_home="${JAVA_HOME:-}"
  if [[ -z "$java_home" && -d /opt/homebrew/opt/openjdk@21 ]]; then
    java_home="/opt/homebrew/opt/openjdk@21"
  fi

  log "starting backend; log: $BACKEND_LOG"
  if [[ -n "$java_home" ]]; then
    (cd "$BACKEND_DIR" && JAVA_HOME="$java_home" nohup ./mvnw spring-boot:run > "$BACKEND_LOG" 2>&1 &)
  else
    (cd "$BACKEND_DIR" && nohup ./mvnw spring-boot:run > "$BACKEND_LOG" 2>&1 &)
  fi

  wait_for_url "$BACKEND_HEALTH_URL" "backend" 60 1
}

start_frontend() {
  if port_listening 5173; then
    log "frontend already listening on 5173"
    return
  fi

  log "starting frontend; log: $FRONTEND_LOG"
  (cd "$FRONTEND_DIR" && nohup npm run dev -- --host 127.0.0.1 --port 5173 > "$FRONTEND_LOG" 2>&1 &)

  wait_for_url "$FRONTEND_URL" "frontend" 40 1
}

print_summary() {
  printf '\n'
  log "ready"
  printf 'Frontend: %s\n' "$FRONTEND_URL"
  printf 'Backend:  http://127.0.0.1:8080/\n'
  printf 'Login:    admin / admin123\n'
  printf 'Logs:     %s\n' "$LOG_DIR"
  printf 'Status:   ./scripts/dev-status.sh\n'
  printf 'Stop:     ./scripts/dev-down.sh\n'
}

ensure_docker_deps
start_backend
start_frontend
print_summary
