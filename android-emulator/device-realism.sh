#!/usr/bin/env bash
# Make the GitHub Actions AVD look/behave closer to a physical Pixel 6.
# Compatible with adb-root userdebug Play images. Never force-stops user apps.
set -euo pipefail

log() { echo "[device-realism] $*"; }

adb_sh() {
  adb shell "$@" 2>/dev/null || true
}

ensure_root() {
  adb wait-for-device
  adb root >/dev/null 2>&1 || true
  sleep 1
  adb wait-for-device
}

# Stable but non-generic serial (Pixel-like 12-char alphanumeric)
SERIAL="${DEVICE_SERIAL:-$(echo -n "${GITHUB_REPOSITORY:-vibely}${GITHUB_RUN_ID:-0}" | sha256sum | cut -c1-12 | tr '[:lower:]' '[:upper:]')}"
# Persistent android_id if provided by pre-launch
if [[ -f /tmp/vibely_persisted_android_id ]]; then
  ANDROID_ID=$(tr -d '\r\n' </tmp/vibely_persisted_android_id)
else
  ANDROID_ID=$(echo -n "aid-${SERIAL}" | md5sum | cut -c1-16)
fi

# Coherent Pixel 6 (oriole) API 34 profile — all partitions aligned
MODEL="Pixel 6"
DEVICE="oriole"
BOARD="oriole"
BRAND="google"
MANUFACTURER="Google"
PRODUCT="oriole"
HARDWARE="oriole"
# Real-style fingerprint shape for oriole / Android 14 (not an SDK fingerprint)
FINGERPRINT="google/oriole/oriole:14/AP2A.240805.005/12025142:user/release-keys"
DESCRIPTION="oriole-user 14 AP2A.240805.005 12025142 release-keys"
ID="AP2A.240805.005"
TAGS="release-keys"
TYPE="user"
HOST="abfarm-release-r2-5"
INCREMENTAL="12025142"
SECURITY_PATCH="2024-08-05"

set_prop() {
  local key="$1" val="$2"
  adb_sh setprop "$key" "$val"
}

apply_build_identity() {
  log "Applying coherent Pixel 6 (oriole) build identity"
  # Product identity (partition-consistent)
  for prefix in "" "bootimage." "odm." "product." "system." "system_ext." "vendor."; do
    set_prop "ro.product.${prefix}brand" "$BRAND"
    set_prop "ro.product.${prefix}device" "$DEVICE"
    set_prop "ro.product.${prefix}manufacturer" "$MANUFACTURER"
    set_prop "ro.product.${prefix}model" "$MODEL"
    set_prop "ro.product.${prefix}name" "$PRODUCT"
  done

  set_prop "ro.product.board" "$BOARD"
  set_prop "ro.board.platform" "gs101"
  set_prop "ro.hardware" "$HARDWARE"
  set_prop "ro.hardware.chipname" "gs101"
  set_prop "ro.build.product" "$PRODUCT"
  set_prop "ro.build.id" "$ID"
  set_prop "ro.build.display.id" "$ID"
  set_prop "ro.build.type" "$TYPE"
  set_prop "ro.build.tags" "$TAGS"
  set_prop "ro.build.user" "android-build"
  set_prop "ro.build.host" "$HOST"
  set_prop "ro.build.description" "$DESCRIPTION"
  set_prop "ro.build.fingerprint" "$FINGERPRINT"
  set_prop "ro.system.build.fingerprint" "$FINGERPRINT"
  set_prop "ro.vendor.build.fingerprint" "$FINGERPRINT"
  set_prop "ro.product.build.fingerprint" "$FINGERPRINT"
  set_prop "ro.system_ext.build.fingerprint" "$FINGERPRINT"
  set_prop "ro.bootimage.build.fingerprint" "$FINGERPRINT"
  set_prop "ro.build.version.incremental" "$INCREMENTAL"
  set_prop "ro.build.version.security_patch" "$SECURITY_PATCH"
  set_prop "ro.vendor.build.security_patch" "$SECURITY_PATCH"
  set_prop "ro.build.version.release" "14"
  set_prop "ro.build.version.release_or_codename" "14"
  set_prop "ro.build.version.sdk" "34"

  # Serial
  set_prop "ro.serialno" "$SERIAL"
  set_prop "ro.boot.serialno" "$SERIAL"
  set_prop "ril.serialnumber" "$SERIAL"
}

hide_emulator_markers() {
  log "Clearing common emulator detection properties"
  # Best-effort: many are read-only after init; still attempt (works on some userdebug paths)
  set_prop "ro.kernel.qemu" "0"
  set_prop "ro.kernel.qemu.gles" "0"
  set_prop "ro.boot.qemu" "0"
  set_prop "ro.boot.qemu.virpipe" "0"
  set_prop "ro.hardware.virtual_device" "0"
  set_prop "ro.boot.hardware" "$HARDWARE"
  set_prop "ro.bootloader" "oriole-1.2-12025142"
  set_prop "ro.bootmode" "normal"
  set_prop "ro.boot.mode" "normal"
  set_prop "ro.debuggable" "0"
  set_prop "ro.secure" "1"
  set_prop "ro.adb.secure" "1"
  set_prop "persist.sys.usb.config" "mtp"
  # Telephony-ish
  set_prop "gsm.version.baseband" "g5123b-131676-240805-B-12025142"
  set_prop "gsm.version.ril-impl" "android reference-ril 1.0"
  set_prop "gsm.sim.state" "READY"
  set_prop "gsm.sim.operator.alpha" "Vibely"
  set_prop "gsm.sim.operator.numeric" "310260"
  set_prop "gsm.operator.alpha" "Vibely"
  set_prop "gsm.operator.numeric" "310260"
  set_prop "gsm.operator.isroaming" "false"
  set_prop "gsm.network.type" "LTE"
  set_prop "gsm.current.phone-type" "1"
}

apply_android_id() {
  log "Setting settings secure android_id=$ANDROID_ID"
  adb_sh settings put secure android_id "$ANDROID_ID"
}

apply_settings_realism() {
  log "Applying realistic device settings"
  # Display / battery / location behaviour closer to a phone
  adb_sh settings put system screen_brightness 128
  adb_sh settings put system screen_off_timeout 2147483647
  adb_sh settings put global device_name "Pixel 6"
  adb_sh settings put global wifi_on 1
  adb_sh settings put global bluetooth_on 1
  adb_sh settings put secure location_mode 3
  # Reduce developer-facing signals when possible
  adb_sh settings put global development_settings_enabled 0
  adb_sh settings put global adb_enabled 1
  adb_sh settings put global stay_on_while_plugged_in 3
}

apply_network_dns() {
  # Prefer public resolvers already set via emulator -dns-server; ensure private DNS off for compatibility
  adb_sh settings put global private_dns_mode off
}

console_cmd() {
  # Emulator console on 5554 when default ADB serial is emulator-5554
  local port="${EMULATOR_CONSOLE_PORT:-5554}"
  if command -v nc >/dev/null 2>&1; then
    printf '%s\n' "$@" "quit" | nc -w 2 127.0.0.1 "$port" >/dev/null 2>&1 || true
  elif command -v telnet >/dev/null 2>&1; then
    { printf '%s\n' "$@"; sleep 0.2; printf 'quit\n'; } | telnet 127.0.0.1 "$port" >/dev/null 2>&1 || true
  fi
}

apply_hardware_console() {
  log "Driving emulator console sensors/geo/power/gsm (best-effort)"
  # Battery ~ phone on charger mid-cycle
  console_cmd "power display on" "power ac on" "power status charging" "power capacity 76"
  # Location: Lagos-ish default (WAT); override with DEVICE_GEO_LAT/LON
  local lat="${DEVICE_GEO_LAT:-6.5244}"
  local lon="${DEVICE_GEO_LON:-3.3792}"
  console_cmd "geo fix ${lon} ${lat}"
  # Sensors: gravity-like acceleration, mild magnetic field, ambient light
  console_cmd \
    "sensor set acceleration 0.12:9.78:0.35" \
    "sensor set magnetic-field 22.0:-9.5:41.0" \
    "sensor set orientation 0.2:2.0:0.1" \
    "sensor set temperature 31.5" \
    "sensor set proximity 5" \
    "sensor set light 320"
  # Cellular: signal present
  console_cmd "gsm signal 8 4" "gsm data on" "gsm voice on"
}

verify() {
  log "Verification snapshot:"
  adb_sh getprop ro.product.model
  adb_sh getprop ro.product.brand
  adb_sh getprop ro.product.device
  adb_sh getprop ro.build.fingerprint
  adb_sh getprop ro.hardware
  adb_sh getprop ro.kernel.qemu
  adb_sh getprop ro.serialno
  adb_sh settings get secure android_id
  adb_sh getprop gsm.sim.state
  adb_sh getprop gsm.network.type
}

main() {
  ensure_root
  apply_build_identity
  hide_emulator_markers
  apply_android_id
  apply_settings_realism
  apply_network_dns
  apply_hardware_console
  verify
  log "Done"
}

main "$@"
