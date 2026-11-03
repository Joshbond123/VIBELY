#!/usr/bin/env bash
# Restore encrypted whole-AVD from GitHub (android-state-v1 + Release assets).
set -euo pipefail

AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
AVD_NAME="${AVD_NAME:-vibely_pixel6_api34}"
AVD_DIR="$AVD_HOME/${AVD_NAME}.avd"
INI="$AVD_HOME/${AVD_NAME}.ini"
ARCHIVE="/tmp/vibely-whole-avd-restore.tar.zst"

mkdir -p "$AVD_HOME" "$HOME/.android"
export ANDROID_CHECKPOINT_IMAGE_FAMILY="${ANDROID_CHECKPOINT_IMAGE_FAMILY:-google_apis_playstore}"
export ANDROID_STATE_BRANCH="${ANDROID_STATE_BRANCH:-android-state-v1}"
export GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-Joshbond123/VIBELY}"

if [[ -z "${EMULATOR_STATE_KEY:-}" || -z "${GH_PAT:-}" ]]; then
  echo "[restore-whole-avd] Missing EMULATOR_STATE_KEY or GH_PAT; first-boot path"
  exit 0
fi

if [[ -d "$AVD_DIR" && -f "$AVD_DIR/config.ini" && "${FORCE_RESTORE:-false}" != "true" ]]; then
  if ls "$AVD_DIR"/userdata* >/dev/null 2>&1; then
    echo "[restore-whole-avd] Local AVD with userdata present; keeping it"
    exit 0
  fi
fi

echo "[restore-whole-avd] Downloading verified whole-AVD checkpoint..."
set +e
python3 github_state.py restore --archive "$ARCHIVE" 2>/tmp/restore-whole-avd.err
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
  echo "[restore-whole-avd] No verified checkpoint available (expected on first production boot):"
  tail -n 40 /tmp/restore-whole-avd.err || true
  # Ensure CAS branch exists so the next save can publish
  python3 github_state.py init --owner "bootstrap_${GITHUB_RUN_ID:-0}" 2>/tmp/state-init.err || true
  exit 0
fi

echo "[restore-whole-avd] Extracting into $AVD_DIR"
python3 - <<'PY'
from pathlib import Path
import os, sys
sys.path.insert(0, '.')
from avd_checkpoint import extract
avd = Path(os.environ.get('HOME', '/home/runner')) / '.android/avd/vibely_pixel6_api34.avd'
archive = Path('/tmp/vibely-whole-avd-restore.tar.zst')
extract(archive, avd)
print('[restore-whole-avd] extract complete')
PY

# Restore host ADB keys from archive if present (portable authorize)
if [[ -d /tmp/vibely-host-adb-restored ]]; then
  true
fi

if [[ -d "$AVD_DIR/snapshots/vibely-checkpoint" ]]; then
  echo "[restore-whole-avd] RAM snapshot vibely-checkpoint present"
  echo "vibely-checkpoint" > /tmp/vibely_snapshot_name
else
  rm -f /tmp/vibely_snapshot_name
fi

# Write .ini if missing
if [[ ! -f "$INI" ]]; then
  cat > "$INI" <<INI
avd.ini.encoding=UTF-8
path=${AVD_DIR}
path.rel=avd/${AVD_NAME}.avd
target=android-34
INI
fi

echo "[restore-whole-avd] OK"
