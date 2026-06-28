#!/usr/bin/env bash

ensure_project_java() {
  local candidate="${JDY_JAVA_HOME:-}"

  if [[ -z "$candidate" ]]; then
    if [[ -x "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java" ]]; then
      candidate="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
    elif [[ -x "/opt/homebrew/opt/openjdk@21/bin/java" ]]; then
      candidate="/opt/homebrew/opt/openjdk@21"
    elif [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then
      candidate="$JAVA_HOME"
    fi
  fi

  if [[ -z "$candidate" || ! -x "$candidate/bin/java" || ! -x "$candidate/bin/javac" ]]; then
    printf 'Java 21 JDK not found. Expected Homebrew OpenJDK at /opt/homebrew/opt/openjdk@21.\n' >&2
    printf 'Install with: brew install openjdk@21\n' >&2
    return 1
  fi

  export JAVA_HOME="$candidate"
  export PATH="$JAVA_HOME/bin:$PATH"
}

