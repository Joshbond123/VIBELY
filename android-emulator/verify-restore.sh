#!/usr/bin/env bash
# Post-restore gate: prove the phone actually got its apps back.
#
# Background: the AVD lives only in an encrypted "whole-AVD" checkpoint that is
# re-uploaded (~8.4 GB) whenever a change settles. If a capture never completed,
# the next runner restores an older generation - or, when the restore fails
# outright, restore-whole-avd.sh bootstraps a factory-fresh AVD. Both look like
# "the phone wiped itself" and neither used to make any noise. This script makes
# that state impossible to miss.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPECTED="${EXPECTED_PACKAGES:-$SCRIPT_DIR/expected-packages.txt}"
OUT_DEVICE="/sdcard/Download/restore-verify.txt"
OUT_HOST="${VERIFY_REPORT:-/tmp/vibely-restore-verify.txt}"

missing=(); present=()
if [[ -f "$EXPECTED" ]]; then
  while IFS= read -r line; do
    pkg="${line%%#*}"; pkg="$(echo "$pkg" | tr -d '[:space:]')"
    [[ -z "$pkg" ]] && continue
    if adb shell "pm path $pkg" 2>/dev/null | grep -q '^package:'; then present+=("$pkg"); else missing+=("$pkg"); fi
  done < "$EXPECTED"
else
  echo "[verify-restore] no expected-packages file at $EXPECTED"
fi

installed_count=$(adb shell 'pm list packages -3 2>/dev/null | wc -l' | tr -d '\r' | tr -d ' ')
gen=$(curl -s --max-time 20 -H "Authorization: Bearer ${GH_PAT:-}" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY:-Joshbond123/VIBELY}/contents/state.json?ref=${ANDROID_STATE_BRANCH:-android-state-v1}" \
  2>/dev/null | python3 -c 'import sys,json,base64
try:
    d=json.load(sys.stdin); print(json.loads(base64.b64decode(d["content"]))["generation"])
except Exception: print("unknown")' 2>/dev/null)

report="[verify-restore] installed_third_party=$installed_count checkpoint_generation=$gen present=${present[*]:-none} missing=${missing[*]:-none}"
echo "$report"
if (( ${#missing[@]} )); then
  echo "[verify-restore] FAIL: this device is missing ${#missing[@]} expected package(s) - the restored checkpoint predates them or the restore fell back to a fresh AVD."
  adb shell "echo '$report' > $OUT_DEVICE" >/dev/null 2>&1 || true
  echo "$report" > "$OUT_HOST"
  exit 1
fi
echo "[verify-restore] PASS: all expected packages present."
adb shell "echo '$report' > $OUT_DEVICE" >/dev/null 2>&1 || true
echo "$report" > "$OUT_HOST"
