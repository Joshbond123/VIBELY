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
hw.ramSize=4096
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


# Load whole-AVD RAM snapshot so restored userdata/settings/accounts match the checkpoint.
if [[ -d "$AVD_DIR/snapshots/vibely-checkpoint" ]]; then
  echo "[pre-launch] Enabling quick-boot from snapshot vibely-checkpoint"
  if [[ -f "$AVD_DIR/config.ini" ]]; then
    sed -i '/^quickboot.chosen=/d;/snapshot.present=/d' "$AVD_DIR/config.ini" || true
    {
      echo "quickboot.chosen=vibely-checkpoint"
      echo "snapshot.present=true"
    } >> "$AVD_DIR/config.ini"
  fi
  echo "vibely-checkpoint" > /tmp/vibely_snapshot_name
fi
