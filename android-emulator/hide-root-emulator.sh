#!/usr/bin/env bash
# Hide root-looking signals and soft-hide emulator markers WITHOUT Magisk/LSPosed.
# Official "Hide My Emulator" requires Magisk + LSPosed (rooted). That path is
# intentionally not installed here so the phone stays unrooted-looking.
set -euo pipefail
log() { echo "[hide-root-emu] $*"; }

adb wait-for-device

# Privileged cleanup while we can still elevate, then drop root for app-visible state.
adb root >/dev/null 2>&1 || true
sleep 1
adb wait-for-device || true

# --- Remove common root artefacts if any were ever pushed ---
log "Scrubbing root binaries / Magisk paths (best-effort)"
for p in \
  /system/bin/su /system/xbin/su /sbin/su /su/bin/su \
  /system/app/Superuser.apk /system/app/SuperSU \
  /data/local/tmp/magisk /data/adb/magisk /data/adb/modules \
  /data/adb/magisk.db /cache/magisk.log
 do
  adb shell "rm -rf $p" >/dev/null 2>&1 || true
done

# --- Developer / debug surface (apps check these) ---
log "Disabling developer-facing settings"
adb shell settings put global development_settings_enabled 0 >/dev/null 2>&1 || true
adb shell settings put global adb_enabled 1 >/dev/null 2>&1 || true
adb shell settings put global stay_on_while_plugged_in 3 >/dev/null 2>&1 || true
adb shell settings put system pointer_location 0 >/dev/null 2>&1 || true
adb shell settings put system show_touches 0 >/dev/null 2>&1 || true
adb shell settings put global verifier_verify_adb_installs 1 >/dev/null 2>&1 || true
adb shell settings put global package_verifier_enable 1 >/dev/null 2>&1 || true

# Soft props (may fail on locked images — ignore)
for kv in \
  "persist.sys.usb.config:mtp" \
  "service.adb.root:0"
 do
  key="${kv%%:*}"; val="${kv#*:}"
  adb shell setprop "$key" "$val" >/dev/null 2>&1 || true
done

# --- Emulator soft-hide already handled in device-realism; reinforce device_name ---
adb shell settings put global device_name "Pixel 6" >/dev/null 2>&1 || true
adb shell settings put secure location_mode 3 >/dev/null 2>&1 || true
adb shell settings put global development_settings_enabled 0 >/dev/null 2>&1 || true

# --- Drop adb root so `id` and service.adb.root look like a normal phone shell ---
log "Dropping adb root (unroot) so the device does not present as rooted"
adb unroot >/dev/null 2>&1 || true
sleep 2
adb wait-for-device || true

log "Verification (should look unrooted)"
adb shell id || true
adb shell getprop ro.debuggable || true
adb shell getprop ro.secure || true
adb shell getprop ro.build.type || true
adb shell getprop ro.build.tags || true
adb shell getprop service.adb.root || true
adb shell settings get global development_settings_enabled || true
adb shell "command -v su || echo 'su: not found'" || true
adb shell "ls /system/xbin/su 2>/dev/null || echo 'no /system/xbin/su'" || true
adb shell "ls /system/bin/su 2>/dev/null || echo 'no /system/bin/su'" || true
adb shell settings get global device_name || true
log "Done — no Magisk/LSPosed/Hide-My-Emulator module installed (would require root)"
