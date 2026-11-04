#!/usr/bin/env bash
set -euo pipefail

echo "[pre-launch] Configuring persistent Android identity and AVD hardware profile..."

mkdir -p "$HOME/.android"
AVD_DIR="$HOME/.android/avd/vibely_pixel6_api34.avd"

# 1. Fetch or initialize persistent ADB host keys + deterministic android_id from android.aivideo.blitz.cloud
if [[ -n "${EMULATOR_GATEWAY_URL:-}" && -n "${EMULATOR_GATEWAY_SECRET:-}" ]]; then
  ID_JSON=$(curl -fsSL --retry 3 --max-time 15 \
    -H "Authorization: Bearer ${EMULATOR_GATEWAY_SECRET}" \
    "${EMULATOR_GATEWAY_URL}/api/internal/state/identity" 2>/dev/null || echo "")

  if [[ -n "$ID_JSON" ]]; then
    AID=$(echo "$ID_JSON" | jq -r '.identity.android_id // empty')
    ADB_PRIV=$(echo "$ID_JSON" | jq -r '.identity.adbkey // empty')
    ADB_PUB=$(echo "$ID_JSON" | jq -r '.identity.adbkey_pub // empty')

    if [[ -n "$AID" ]]; then
      echo -n "$AID" > /tmp/vibely_persisted_android_id
      echo "[pre-launch] Loaded persistent android_id: $AID"
    fi

    if [[ -n "$ADB_PRIV" && -n "$ADB_PUB" ]]; then
      printf "%s" "$ADB_PRIV" | base64 -d > "$HOME/.android/adbkey"
      printf "%s" "$ADB_PUB" | base64 -d > "$HOME/.android/adbkey.pub"
      chmod 600 "$HOME/.android/adbkey"
      chmod 644 "$HOME/.android/adbkey.pub"
      echo "[pre-launch] Restored persistent ADB cryptographic host keys."
    fi
  fi
fi

# Generate ADB keys on very first ever launch and persist them upstream
if [[ ! -f "$HOME/.android/adbkey" ]]; then
  if command -v adb >/dev/null 2>&1; then
    adb keygen "$HOME/.android/adbkey" || true
  fi
fi

if [[ -f "$HOME/.android/adbkey" && -n "${EMULATOR_GATEWAY_URL:-}" && -n "${EMULATOR_GATEWAY_SECRET:-}" ]]; then
  B64_PRIV=$(base64 -w0 "$HOME/.android/adbkey")
  B64_PUB=$(base64 -w0 "$HOME/.android/adbkey.pub")
  CUR_AID=$(cat /tmp/vibely_persisted_android_id 2>/dev/null || openssl rand -hex 8)
  echo -n "$CUR_AID" > /tmp/vibely_persisted_android_id
  jq -n --arg aid "$CUR_AID" --arg priv "$B64_PRIV" --arg pub "$B64_PUB" \
    '{android_id: $aid, adbkey: $priv, adbkey_pub: $pub}' | \
    curl -fsSL --max-time 15 -X PUT \
      -H "Authorization: Bearer ${EMULATOR_GATEWAY_SECRET}" \
      -H "Content-Type: application/json" \
      --data-binary @- \
      "${EMULATOR_GATEWAY_URL}/api/internal/state/identity" >/dev/null 2>&1 || true
fi

# 2. Tune AVD config.ini for consistent Pixel 6 (1080x2400) display, hardware keyboard & storage
if [[ -d "$AVD_DIR" && -f "$AVD_DIR/config.ini" ]]; then
  # Strip prior overrides then apply a coherent Pixel-6-like hardware profile
  sed -i     '/^hw.keyboard=/d;/^hw.lcd.width=/d;/^hw.lcd.height=/d;/^hw.lcd.density=/d;/^disk.dataPartition.size=/d;'     -e '/^hw.gps=/d;/^hw.accelerometer=/d;/^hw.gyroscope=/d;/^hw.sensors.proximity=/d;'     -e '/^hw.sensors.magnetic_field=/d;/^hw.sensors.orientation=/d;/^hw.sensors.pressure=/d;'     -e '/^hw.battery=/d;/^hw.camera.back=/d;/^hw.camera.front=/d;/^hw.audioInput=/d;/^hw.audioOutput=/d;'     -e '/^hw.gpu.enabled=/d;/^hw.gpu.mode=/d;/^hw.ramSize=/d;/^hw.cpu.ncore=/d;/^hw.sdCard=/d;'     -e '/^hw.mainKeys=/d;/^hw.trackBall=/d;/^hw.dPad=/d;/^hw.gsmModem=/d;/^hw.arc=/d;'     -e '/^AvdId=/d;/^avd.ini.displayname=/d'     "$AVD_DIR/config.ini" 2>/dev/null || true
  cat >> "$AVD_DIR/config.ini" << 'EOF'
AvdId=Pixel_6
avd.ini.displayname=Pixel 6
hw.keyboard=yes
hw.mainKeys=no
hw.trackBall=no
hw.dPad=no
hw.lcd.width=1080
hw.lcd.height=2400
hw.lcd.density=420
disk.dataPartition.size=8192M
hw.ramSize=6144
hw.cpu.ncore=4
hw.gps=yes
hw.accelerometer=yes
hw.gyroscope=yes
hw.sensors.proximity=yes
hw.sensors.magnetic_field=yes
hw.sensors.orientation=yes
hw.sensors.pressure=yes
hw.battery=yes
hw.audioInput=yes
hw.audioOutput=yes
hw.camera.back=emulated
hw.camera.front=emulated
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
hw.sdCard=yes
hw.gsmModem=yes
hw.arc=false
EOF
  echo "[pre-launch] Applied Pixel 6 realistic hardware profile to $AVD_DIR/config.ini"
fi

# ROOT CAUSE FIX — never quick-boot from a RAM snapshot.
# A RAM snapshot captured while Play Store was mid-install carries a frozen
# DownloadManager/PackageInstaller state that can never complete, so "Installing…"
# reappeared after every single rotation. The persisted whole-AVD disks are
# crash-consistent (captured with the vCPU paused), so every rotation now boots a
# clean Android from the saved disk: accounts, apps, app data, permissions and
# downloads are all present, with no stale in-flight work.
if [[ -d "$AVD_DIR" ]]; then
  rm -rf "$AVD_DIR/snapshots"
  rm -f /tmp/vibely_snapshot_name
  if [[ -f "$AVD_DIR/config.ini" ]]; then
    sed -i '/^quickboot[.]/d;/^snapshot[.]present=/d;/^fastboot[.]/d' "$AVD_DIR/config.ini" || true
    echo "snapshot.present=false" >> "$AVD_DIR/config.ini"
  fi
  echo "[pre-launch] Disabled quick-boot; guest will cold-boot from the persisted data disk."
fi

# Storage headroom check: Play Store refuses/!stalls installs when /data is tight.
if [[ -f "$AVD_DIR/config.ini" ]]; then
  echo "[pre-launch] AVD disk layout:"
  du -sh "$AVD_DIR" 2>/dev/null || true
  ls -la "$AVD_DIR" | awk '{print "  "$5" "$9}' | grep -E 'img|qcow2' || true
fi

# Root the production image the only supported way: patch the emulator ramdisk on
# the host and boot with `-ramdisk /tmp/vibely-ramdisk.img` (see root-live.py and
# the emulator-options in android-emulator.yml).  Needed because a Play image
# refuses `setprop ro.*`, so the phone can never stop reporting itself as
# sdk_gphone64_x86_64 — which is exactly what makes TextMe's Play-Integrity
# backed signup answer "Unable to Sign Up".
# root-live.py always leaves a bootable image behind (stock ramdisk on failure),
# so a patch failure degrades to today's behaviour instead of a black screen.
if [[ -f "$(dirname "${BASH_SOURCE[0]}")/root-live.py" ]]; then
  echo "[pre-launch] Preparing Magisk root ramdisk for the production AVD..."
  python3 "$(dirname "${BASH_SOURCE[0]}")/root-live.py" || echo "[pre-launch] root-live reported a problem; stock ramdisk will be used"
fi
