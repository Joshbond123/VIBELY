#!/usr/bin/env bash
# Device realism for GitHub Actions AVD (Pixel 6 profile).
# Focus on layers that actually work without Magisk/resetprop:
#   AVD hardware (pre-launch), adb emu console, settings, writable props.
set -euo pipefail
log() { echo "[device-realism] $*"; }

adb wait-for-device
adb root >/dev/null 2>&1 || true
sleep 1
adb wait-for-device || true

SERIAL="${DEVICE_SERIAL:-$(echo -n "${GITHUB_REPOSITORY:-vibely}${GITHUB_RUN_ID:-0}" | sha256sum | cut -c1-12 | tr '[:lower:]' '[:upper:]')}"
if [[ -f /tmp/vibely_persisted_android_id ]]; then
  ANDROID_ID=$(tr -d '\r\n' </tmp/vibely_persisted_android_id)
else
  ANDROID_ID=$(echo -n "aid-${SERIAL}" | md5sum | cut -c1-16)
fi

# --- Settings (always work; apps often read these) ---
log "Settings identity + phone behaviour"
adb shell settings put secure android_id "$ANDROID_ID" || true
adb shell settings put global device_name "Pixel 6" || true
adb shell settings put system screen_brightness 128 || true
adb shell settings put system screen_off_timeout 2147483647 || true
adb shell settings put global wifi_on 1 || true
adb shell settings put global bluetooth_on 1 || true
adb shell settings put secure location_mode 3 || true
adb shell settings put global private_dns_mode off || true
adb shell settings put global development_settings_enabled 0 || true
adb shell settings put global stay_on_while_plugged_in 3 || true
adb shell svc power stayon true || true

# --- Writable / soft props (best-effort; ro.* often blocked on Play images) ---
log "Writable property attempts"
for kv in \
  "persist.sys.timezone:Africa/Lagos" \
  "persist.sys.language:en" \
  "persist.sys.country:US" \
  "persist.sys.phone.name:Pixel 6" \
  "net.hostname:Pixel-6" \
  "gsm.sim.state:READY" \
  "gsm.network.type:LTE" \
  "gsm.operator.alpha:Vibely" \
  "gsm.sim.operator.alpha:Vibely" \
  "gsm.operator.numeric:310260" \
  "gsm.sim.operator.numeric:310260" \
  "gsm.operator.isroaming:false"
 do
  key="${kv%%:*}"; val="${kv#*:}"
  adb shell setprop "$key" "$val" >/dev/null 2>&1 || true
done

# --- Emulator console via adb emu (sensors / geo / power / gsm) ---
log "Hardware console via adb emu"
LAT="${DEVICE_GEO_LAT:-6.5244}"
LON="${DEVICE_GEO_LON:-3.3792}"
adb emu geo fix "$LON" "$LAT" || true
adb emu power display on || true
adb emu power ac on || true
adb emu power status charging || true
adb emu power capacity 76 || true
adb emu sensor set acceleration 0.12:9.78:0.35 || true
adb emu sensor set magnetic-field 22.0:-9.5:41.0 || true
adb emu sensor set orientation 0.2:2.0:0.1 || true
adb emu sensor set temperature 31.5 || true
adb emu sensor set proximity 5 || true
adb emu sensor set light 320 || true
adb emu gsm signal 8 4 || true
adb emu gsm data on || true
adb emu gsm voice on || true

# --- Camera / media: ensure mock location allowed for apps that need it ---
adb shell appops set com.google.android.gms MOCK_LOCATION allow >/dev/null 2>&1 || true

log "Verification"
adb shell getprop ro.product.model || true
adb shell getprop ro.product.brand || true
adb shell getprop ro.hardware || true
adb shell getprop ro.kernel.qemu || true
adb shell getprop ro.build.fingerprint || true
adb shell settings get secure android_id || true
adb shell settings get global device_name || true
adb shell getprop gsm.network.type || true
adb shell getprop gsm.sim.state || true
adb shell getprop persist.sys.timezone || true
log "Done (ro.* fingerprints may remain SDK defaults without Magisk resetprop)"
