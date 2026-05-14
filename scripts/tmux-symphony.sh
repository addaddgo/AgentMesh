#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="/home/qingren/projects/symphony"
SESSION_NAME="${SYMPHONY_TMUX_SESSION:-symphony}"
NVM_ROOT="${HOME}/.nvm/versions/node"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required but was not found in PATH." >&2
  exit 1
fi

if [ -d "${NVM_ROOT}" ]; then
  NODE_BIN_DIR="$(find "${NVM_ROOT}" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)/bin"
  export PATH="${NODE_BIN_DIR}:${PATH}"
fi

start_session() {
  if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
    echo "tmux session '${SESSION_NAME}' is already running."
    exit 0
  fi

  tmux new-session -d -s "${SESSION_NAME}" -c "${PROJECT_ROOT}" "exec ./scripts/start-symphony.sh"
  echo "Started Symphony in tmux session '${SESSION_NAME}'."
}

stop_session() {
  if ! tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
    echo "tmux session '${SESSION_NAME}' is not running."
    exit 0
  fi

  tmux kill-session -t "${SESSION_NAME}"
  echo "Stopped tmux session '${SESSION_NAME}'."
}

status_session() {
  if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
    tmux display-message -p -t "${SESSION_NAME}" "Session '#S' running at pane #{pane_pid}"
    return 0
  fi

  echo "tmux session '${SESSION_NAME}' is not running."
  return 1
}

attach_session() {
  exec tmux attach-session -t "${SESSION_NAME}"
}

logs_session() {
  exec tmux capture-pane -p -t "${SESSION_NAME}:0.0"
}

usage() {
  cat <<'EOF'
Usage: ./scripts/tmux-symphony.sh <start|stop|restart|status|attach|logs>
EOF
}

command_name="${1:-start}"

case "${command_name}" in
  start)
    start_session
    ;;
  stop)
    stop_session
    ;;
  restart)
    stop_session || true
    start_session
    ;;
  status)
    status_session
    ;;
  attach)
    attach_session
    ;;
  logs)
    logs_session
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
