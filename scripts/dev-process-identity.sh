#!/usr/bin/env bash

# Shared process/build identity helpers for local development scripts.
# Keep this file side-effect free: it is sourced by dev-up.sh and its behavior test.

jdy_sha256_stdin() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
    return
  fi

  printf 'Neither shasum nor sha256sum is available; cannot calculate build identity.\n' >&2
  return 1
}

jdy_canonical_dir() {
  (cd "$1" 2>/dev/null && pwd -P)
}

jdy_backend_build_fingerprint() {
  local root_dir="$1"
  local backend_dir="$2"
  local canonical_root
  local canonical_backend
  local source_paths

  canonical_root="$(jdy_canonical_dir "$root_dir")" || return 1
  canonical_backend="$(jdy_canonical_dir "$backend_dir")" || return 1

  source_paths="$({
    git -C "$canonical_root" ls-files --cached --others --exclude-standard -- \
      backend/pom.xml \
      backend/mvnw \
      backend/mvnw.cmd \
      backend/.mvn \
      backend/src
  } | LC_ALL=C sort)" || return 1

  if [[ -z "$source_paths" ]]; then
    printf 'No backend build inputs found under %s.\n' "$canonical_backend" >&2
    return 1
  fi

  {
    # The canonical workspace path intentionally participates in the identity.
    # An identical checkout in another workspace must not be reused implicitly.
    printf 'identity-format\tjdy-dev-build-v1\n'
    printf 'workspace-root\t%s\n' "$canonical_root"
    printf 'backend-root\t%s\n' "$canonical_backend"
    while IFS= read -r relative_path; do
      if [[ -f "$canonical_root/$relative_path" || -L "$canonical_root/$relative_path" ]]; then
        printf '%s\t%s\n' \
          "$relative_path" \
          "$(git -C "$canonical_root" hash-object -- "$canonical_root/$relative_path")"
      else
        # A deleted tracked source is still an input and must change the identity.
        printf '%s\t<MISSING>\n' "$relative_path"
      fi
    done <<< "$source_paths"
  } | jdy_sha256_stdin
}

jdy_pid_working_directory() {
  local pid="$1"
  local cwd

  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk 'substr($0, 1, 1) == "n" { print substr($0, 2); exit }')"
  [[ -n "$cwd" ]] || return 1
  jdy_canonical_dir "$cwd"
}

jdy_process_cwd_belongs_to() {
  local pid="$1"
  local expected_dir="$2"
  local actual_cwd
  local canonical_expected

  actual_cwd="$(jdy_pid_working_directory "$pid")" || return 1
  canonical_expected="$(jdy_canonical_dir "$expected_dir")" || return 1

  [[ "$actual_cwd" == "$canonical_expected" || "$actual_cwd" == "$canonical_expected/"* ]]
}
