#!/usr/bin/env bash
set -euo pipefail

AVD_HOME="${ANDROID_AVD_HOME:-$HOME/.android/avd}"
AVD_NAME="${AVD_NAME:-vibely_pixel6_api34}"
AVD_DIR="$AVD_HOME/${AVD_NAME}.avd"
OWNER="${EMULATOR_SESSION_ID:-owner_${GITHUB_RUN_ID:-local}}"
HOLD="${CHECKPOINT_HOLD:-false}"
ARCHIVE="/tmp/vibely-whole-avd-save-$$.tar.zst"

export ANDROID_CHECKPOINT_IMAGE_FAMILY="${ANDROID_CHECKPOINT_IMAGE_FAMILY:-google_apis_playstore}"
export ANDROID_STATE_BRANCH="${ANDROID_STATE_BRANCH:-android-state-v1}"
export GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-Joshbond123/VIBELY}"

if [[ -z "${EMULATOR_STATE_KEY:-}" || -z "${GH_PAT:-}" ]]; then
  echo "[save-whole-avd] Missing secrets"; exit 1
fi
if [[ ! -d "$AVD_DIR" ]]; then
  echo "[save-whole-avd] Missing AVD $AVD_DIR"; exit 1
fi

ARGS=(capture --avd "$AVD_DIR" --archive "$ARCHIVE")
[[ "$HOLD" == "true" ]] && ARGS+=(--hold)

echo "[save-whole-avd] Capturing..."
python3 android-emulator/avd_checkpoint.py "${ARGS[@]}"
META=$(jq -n --arg run "${GITHUB_RUN_ID:-}" --arg avd "$AVD_NAME" --arg fam "$ANDROID_CHECKPOINT_IMAGE_FAMILY" \
  '{source_run:$run,avd:$avd,family:$fam,format:"whole-avd-v1"}')
echo "[save-whole-avd] Publishing (incomplete snapshots never become current)..."
python3 android-emulator/github_state.py publish --archive "$ARCHIVE" --owner "$OWNER" --metadata "$META"
rm -f "$ARCHIVE"
echo "[save-whole-avd] Done"
