#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

for bin in jq zstd ffmpeg openssl curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y -qq jq zstd ffmpeg openssl curl
    break
  fi
done

if [[ ! -d node_modules ]]; then
  npm install --no-audit --no-fund
fi

exec node ./agent.mjs
