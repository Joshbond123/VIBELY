#!/usr/bin/env bash
# Soft anti-root appearance WITHOUT disconnecting the emulator adb transport.
# CRITICAL: do NOT run `adb unroot` on the Android Emulator — it often drops
# emulator-5554 offline and freezes install/control while the video stream still shows a picture.
set -euo pipefail
log() { echo "[hide-root-emu] $*"; }

adb wait-for-device

# Elevate only if needed for cleanup; stay rooted for reliable agent control on AVD.
adb root >/dev/null 2>&1 || true
sleep 1
adb wait-for-device || true

log "Scrub root artefacts (best-effort)"
for p in \
  /system/bin/su /system/xbin/su /sbin/su /su/bin/su \
  /system/app/Superuser.apk /system/app/SuperSU \
  /data/local/tmp/magisk
 do
  adb shell "rm -rf $p" >/dev/null 2>&1 || true
done

log "Developer surface off"
adb shell settings put global development_settings_enabled 0 >/dev/null 2>&1 || true
adb shell settings put system pointer_location 0 >/dev/null 2>&1 || true
adb shell settings put system show_touches 0 >/dev/null 2>&1 || true
adb shell settings put global device_name "Pixel 6" >/dev/null 2>&1 || true

log "Verify adb still has a device"
adb devices -l || true
log "Done (kept adb root on AVD for reliability — no Magisk/su installed)"
