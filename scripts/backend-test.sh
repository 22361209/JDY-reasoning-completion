#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Keep Java local to this project instead of relying on the user's shell profile.
source "$ROOT_DIR/scripts/java-env.sh"
ensure_project_java

cd "$ROOT_DIR/backend"
printf '[backend-test] JAVA_HOME=%s\n' "$JAVA_HOME"

if [[ "$#" -eq 0 ]]; then
  exec ./mvnw test
fi

exec ./mvnw "$@"

