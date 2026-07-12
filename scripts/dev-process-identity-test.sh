#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/dev-process-identity.sh"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jdy-dev-identity.XXXXXX")"
SLEEP_PID=""

cleanup() {
  if [[ -n "$SLEEP_PID" ]]; then
    kill "$SLEEP_PID" >/dev/null 2>&1 || true
    wait "$SLEEP_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT INT TERM

fail() {
  printf '[dev-process-identity-test] FAIL: %s\n' "$*" >&2
  exit 1
}

assert_file_contains() {
  local file="$1"
  local expected="$2"
  grep -Fq "$expected" "$file" || fail "$file is missing required wiring: $expected"
}

assert_file_contains "$ROOT_DIR/scripts/dev-up.sh" 'BACKEND_BUILD_FINGERPRINT="$(jdy_backend_build_fingerprint "$ROOT_DIR" "$BACKEND_DIR")"'
assert_file_contains "$ROOT_DIR/scripts/dev-up.sh" 'JDY_DEV_BUILD_FINGERPRINT='
assert_file_contains "$ROOT_DIR/scripts/dev-up.sh" 'backend_build_identity_ready'
assert_file_contains "$ROOT_DIR/scripts/dev-up.sh" 'jdy_process_cwd_belongs_to "$pid" "$FRONTEND_DIR"'
assert_file_contains "$ROOT_DIR/backend/src/main/resources/application.yml" 'build-fingerprint: ${JDY_DEV_BUILD_FINGERPRINT:}'

WORKSPACE_ONE="$TMP_ROOT/workspace-one"
WORKSPACE_TWO="$TMP_ROOT/workspace-two"

mkdir -p "$WORKSPACE_ONE/backend/src/main/java/example" "$WORKSPACE_ONE/backend/.mvn/wrapper"
git -C "$WORKSPACE_ONE" init -q
printf '<project/>\n' > "$WORKSPACE_ONE/backend/pom.xml"
printf '#!/usr/bin/env sh\n' > "$WORKSPACE_ONE/backend/mvnw"
printf 'class Example {}\n' > "$WORKSPACE_ONE/backend/src/main/java/example/Example.java"
git -C "$WORKSPACE_ONE" add backend

fingerprint_one="$(jdy_backend_build_fingerprint "$WORKSPACE_ONE" "$WORKSPACE_ONE/backend")"
fingerprint_one_repeat="$(jdy_backend_build_fingerprint "$WORKSPACE_ONE" "$WORKSPACE_ONE/backend")"
[[ "$fingerprint_one" == "$fingerprint_one_repeat" ]] || fail "unchanged inputs produced different fingerprints"

printf 'class Example { int revision = 2; }\n' > "$WORKSPACE_ONE/backend/src/main/java/example/Example.java"
fingerprint_changed="$(jdy_backend_build_fingerprint "$WORKSPACE_ONE" "$WORKSPACE_ONE/backend")"
[[ "$fingerprint_one" != "$fingerprint_changed" ]] || fail "a backend source edit did not change the fingerprint"

printf 'class Example {}\n' > "$WORKSPACE_ONE/backend/src/main/java/example/Example.java"
printf 'class Added {}\n' > "$WORKSPACE_ONE/backend/src/main/java/example/Added.java"
fingerprint_untracked="$(jdy_backend_build_fingerprint "$WORKSPACE_ONE" "$WORKSPACE_ONE/backend")"
[[ "$fingerprint_one" != "$fingerprint_untracked" ]] || fail "an untracked backend source did not change the fingerprint"
rm "$WORKSPACE_ONE/backend/src/main/java/example/Added.java"

mkdir -p "$WORKSPACE_TWO"
cp -R "$WORKSPACE_ONE/backend" "$WORKSPACE_TWO/backend"
git -C "$WORKSPACE_TWO" init -q
git -C "$WORKSPACE_TWO" add backend
fingerprint_other_workspace="$(jdy_backend_build_fingerprint "$WORKSPACE_TWO" "$WORKSPACE_TWO/backend")"
[[ "$fingerprint_one" != "$fingerprint_other_workspace" ]] || fail "a different workspace path produced the same fingerprint"

mkdir -p "$TMP_ROOT/frontend" "$TMP_ROOT/other-frontend"
(
  cd "$TMP_ROOT/frontend"
  exec sleep 20
) &
SLEEP_PID="$!"

cwd_ready=false
for _ in 1 2 3 4 5; do
  if jdy_process_cwd_belongs_to "$SLEEP_PID" "$TMP_ROOT/frontend"; then
    cwd_ready=true
    break
  fi
  sleep 0.1
done
[[ "$cwd_ready" == true ]] || fail "could not verify the listener-style process cwd"
if jdy_process_cwd_belongs_to "$SLEEP_PID" "$TMP_ROOT/other-frontend"; then
  fail "a process from another frontend workspace was accepted"
fi

printf '[dev-process-identity-test] PASS\n'
