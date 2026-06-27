#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
LOG_DIR="$ROOT_DIR/verification/logs"
BACKEND_LOG="$LOG_DIR/backend-dev-live.log"
FRONTEND_LOG="$LOG_DIR/frontend-dev-live.log"
BACKEND_PID_FILE="$LOG_DIR/backend-dev.pid"
FRONTEND_PID_FILE="$LOG_DIR/frontend-dev.pid"
BACKEND_SESSION="jdy-erp-backend"
FRONTEND_SESSION="jdy-erp-frontend"
FRONTEND_URL="http://127.0.0.1:5173/"
BACKEND_HEALTH_URL="http://127.0.0.1:8080/actuator/health"

mkdir -p "$LOG_DIR"

log() {
  printf '[dev-up] %s\n' "$*"
}

port_listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

listening_pid() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1
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

pid_alive() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

screen_available() {
  command -v screen >/dev/null 2>&1
}

screen_running() {
  local session="$1"
  screen_available && screen -ls 2>/dev/null | grep -q "[.]${session}[[:space:]]"
}

start_screen_session() {
  local session="$1"
  local command="$2"
  screen -S "$session" -X quit >/dev/null 2>&1 || true
  screen -dmS "$session" bash -lc "$command"
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
    listening_pid 8080 > "$BACKEND_PID_FILE" || true
    log "backend already listening on 8080"
    return
  fi

  local java_home="${JAVA_HOME:-}"
  if [[ -z "$java_home" && -d /opt/homebrew/opt/openjdk@21 ]]; then
    java_home="/opt/homebrew/opt/openjdk@21"
  fi

  log "starting backend; log: $BACKEND_LOG"
  if screen_available; then
    if [[ -n "$java_home" ]]; then
      start_screen_session "$BACKEND_SESSION" "cd '$BACKEND_DIR' && exec env JAVA_HOME='$java_home' ./mvnw spring-boot:run > '$BACKEND_LOG' 2>&1"
    else
      start_screen_session "$BACKEND_SESSION" "cd '$BACKEND_DIR' && exec ./mvnw spring-boot:run > '$BACKEND_LOG' 2>&1"
    fi
    printf 'screen:%s\n' "$BACKEND_SESSION" > "$BACKEND_PID_FILE"
  else
    (
      cd "$BACKEND_DIR"
      if [[ -n "$java_home" ]]; then
        nohup env JAVA_HOME="$java_home" ./mvnw spring-boot:run > "$BACKEND_LOG" 2>&1 &
      else
        nohup ./mvnw spring-boot:run > "$BACKEND_LOG" 2>&1 &
      fi
      printf '%s\n' "$!" > "$BACKEND_PID_FILE"
    )
  fi

  wait_for_url "$BACKEND_HEALTH_URL" "backend" 60 1
  sleep 2
  listening_pid 8080 > "$BACKEND_PID_FILE" || true
  if ! port_listening 8080 && ! pid_alive "$BACKEND_PID_FILE" && ! screen_running "$BACKEND_SESSION"; then
    log "backend exited after startup; tailing log:"
    tail -n 80 "$BACKEND_LOG" || true
    return 1
  fi
}

start_frontend() {
  if port_listening 5173; then
    listening_pid 5173 > "$FRONTEND_PID_FILE" || true
    log "frontend already listening on 5173"
    return
  fi

  log "starting frontend; log: $FRONTEND_LOG"
  if screen_available; then
    start_screen_session "$FRONTEND_SESSION" "cd '$FRONTEND_DIR' && exec npm run dev -- --host 127.0.0.1 --port 5173 > '$FRONTEND_LOG' 2>&1"
    printf 'screen:%s\n' "$FRONTEND_SESSION" > "$FRONTEND_PID_FILE"
  else
    (
      cd "$FRONTEND_DIR"
      nohup npm run dev -- --host 127.0.0.1 --port 5173 > "$FRONTEND_LOG" 2>&1 &
      printf '%s\n' "$!" > "$FRONTEND_PID_FILE"
    )
  fi

  wait_for_url "$FRONTEND_URL" "frontend" 40 1
  listening_pid 5173 > "$FRONTEND_PID_FILE" || true
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
