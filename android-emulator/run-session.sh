#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

for bin in jq zstd openssl curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y -qq jq zstd openssl curl
    break
  fi
done

if [[ ! -d node_modules ]]; then
  npm install --no-audit --no-fund
fi

# Pinned official server; downloaded on the Actions runner, not in the user's browser.
if [[ ! -f scrcpy-server.jar ]]; then
  curl --fail --location --retry 3 --output scrcpy-server.jar https://github.com/Genymobile/scrcpy/releases/download/v3.3.4/scrcpy-server-v3.3.4
fi
echo '8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e  scrcpy-server.jar' | sha256sum --check --status
exec node ./agent.mjs
