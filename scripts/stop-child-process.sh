#!/usr/bin/env bash

# Reap a child process without allowing a failed graceful shutdown to block CI.
# This file is sourced so `wait` runs in the shell that owns the child.
stop_child_process() {
  local child_pid="$1"
  local graceful_timeout="${2:-10}"
  local terminate_timeout="${3:-5}"
  local watchdog_pid

  case "$child_pid" in
    ''|*[!0-9]*)
      echo "invalid child process id: $child_pid" >&2
      return 2
      ;;
  esac

  if ! kill -0 "$child_pid" 2>/dev/null; then
    wait "$child_pid" 2>/dev/null || true
    return 0
  fi

  (
    sleep "$graceful_timeout"
    if kill -0 "$child_pid" 2>/dev/null; then
      kill -TERM "$child_pid" 2>/dev/null || true
      sleep "$terminate_timeout"
    fi
    if kill -0 "$child_pid" 2>/dev/null; then
      kill -KILL "$child_pid" 2>/dev/null || true
    fi
  ) &
  watchdog_pid=$!

  wait "$child_pid" 2>/dev/null || true
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
}
