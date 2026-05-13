#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="/home/qingren/projects/symphony"
NVM_ROOT="${HOME}/.nvm/versions/node"

if [ -d "${NVM_ROOT}" ]; then
  NODE_BIN_DIR="$(find "${NVM_ROOT}" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)/bin"
  export PATH="${NODE_BIN_DIR}:${PATH}"
fi

cd "${PROJECT_ROOT}"
exec corepack pnpm --parallel --filter @agentmesh/backend --filter @agentmesh/frontend dev
