#!/usr/bin/env bash
set -euo pipefail

echo "[pre-launch] Configuring persistent Android identity and AVD hardware profile..."

mkdir -p "$HOME/.android"
AVD_DIR="$HOME/.android/avd/vibely_pixel6_api34.avd"

# 1. Fetch or initialize persistent ADB host keys + deterministic android_id from cserver.blitz.cloud
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
  sed -i '/^hw.keyboard=/d;/^hw.lcd.width=/d;/^hw.lcd.height=/d;/^hw.lcd.density=/d;/^disk.dataPartition.size=/d' "$AVD_DIR/config.ini"
  cat >> "$AVD_DIR/config.ini" << 'EOF'
hw.keyboard=yes
hw.lcd.width=1080
hw.lcd.height=2400
hw.lcd.density=420
disk.dataPartition.size=6144M
EOF
  echo "[pre-launch] Applied Pixel 6 (1080x2400 @ 420dpi, 6GB /data) overrides to $AVD_DIR/config.ini"
fi
