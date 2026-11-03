#!/usr/bin/env bash
# Soft anti-root appearance WITHOUT disconnecting the emulator adb transport.
# CRITICAL: do NOT run `adb unroot` on the Android Emulator — it often drops
# emulator-5554 offline and freezes install/control while the video stream still shows a picture.
set -euo pipefail
log() { echo "[hide-root-emu] $*"; }

adb wait-for-device

# Play Store images are production builds: `adb root` is impossible and the
# failed attempt restarts adbd, which disconnects the tunnel and can freeze
# pending Play installs. There is no su/Magisk here to scrub either.

log "Root artefact check (read-only; nothing to remove on Play images)"
for p in /system/bin/su /system/xbin/su /sbin/su /su/bin/su /system/app/Superuser.apk /system/app/SuperSU; do
  adb shell "ls $p" >/dev/null 2>&1 && log "present: $p" || true
done

log "Developer surface off"
adb shell settings put global development_settings_enabled 0 >/dev/null 2>&1 || true
adb shell settings put system pointer_location 0 >/dev/null 2>&1 || true
adb shell settings put system show_touches 0 >/dev/null 2>&1 || true
adb shell settings put global device_name "Pixel 6" >/dev/null 2>&1 || true

log "Verify adb still has a device"
adb devices -l || true
log "Done (Play image stays unrooted — nothing to hide, no Magisk/su installed)"
