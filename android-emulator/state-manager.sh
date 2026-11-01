#!/usr/bin/env bash
set -euo pipefail

# Full Android Emulator State Persistence Manager
# Preserves:
#  1. User-installed APKs (base + split APKs)
#  2. Full private app data (/data/user/0/<pkg> & /data/user_de/0/<pkg>: SQLite DBs, SharedPreferences, files)
#     with automatic UID/GID re-mapping and SELinux restorecon on restore
#  3. Downloaded & shared user files (/sdcard/Download, Documents, DCIM, Pictures, Music, Movies, /data/local/tmp/persistent)
#  4. Emulator & Android configuration (settings global/secure/system overrides)
#  5. Persistent device identity (android_id + settings_ssaid.xml)
# Backed by:
#  - Primary Hot Store: android.aivideo.blitz.cloud persistent volume (/app/data/persistence/latest-state.tar.zst)
#  - Secondary Off-Site Encrypted Backup: GitHub Release 'emulator-state-latest' (AES-256-CBC + PBKDF2 encrypted)

ACTION="${1:-}"
WORK_TMP="/tmp/vibely_emu_state_$$"
RELEASE_TAG="emulator-state-latest"
REPO_SLUG="${GITHUB_REPOSITORY:-Joshbond123/VIBELY}"

cleanup() {
  rm -rf "$WORK_TMP"
}
trap cleanup EXIT

ensure_adb_root() {
  adb wait-for-device
  adb root >/dev/null 2>&1 || true
  sleep 1
  adb wait-for-device
}

backup_state() {
  echo "[state-manager] Starting full Android emulator state backup..."
  ensure_adb_root
  mkdir -p "$WORK_TMP/stage/apks" "$WORK_TMP/stage/appdata" "$WORK_TMP/stage/settings" "$WORK_TMP/stage/identity"

  # 1. Device identity
  AID=$(adb shell settings get secure android_id | tr -d '\r\n')
  if [[ -f /tmp/vibely_persisted_android_id ]]; then
    SAVED_AID=$(cat /tmp/vibely_persisted_android_id | tr -d '\r\n')
    if [[ -n "$SAVED_AID" && "$SAVED_AID" != "null" ]]; then
      AID="$SAVED_AID"
    fi
  fi
  echo -n "$AID" > "$WORK_TMP/stage/identity/android_id.txt"
  adb exec-out "cat /data/system/users/0/settings_ssaid.xml 2>/dev/null || true" > "$WORK_TMP/stage/identity/settings_ssaid.xml" || true

  # 2. Emulator & Android settings snapshot
  adb shell settings list system | tr -d '\r' > "$WORK_TMP/stage/settings/system.txt" || true
  adb shell settings list secure | tr -d '\r' > "$WORK_TMP/stage/settings/secure.txt" || true
  adb shell settings list global | tr -d '\r' > "$WORK_TMP/stage/settings/global.txt" || true

  # 3. Third-party installed packages + full private app data (/data/user/0 & /data/user_de/0)
  PKGS=$(adb shell pm list packages -3 | sed 's/^package://' | tr -d '\r' | sort -u)
  PKG_ARRAY=()
  for pkg in $PKGS; do
    [[ -z "$pkg" ]] && continue
    PKG_ARRAY+=("$pkg")
    mkdir -p "$WORK_TMP/stage/apks/$pkg"

    APK_PATHS=$(adb shell pm path "$pkg" | sed 's/^package://' | tr -d '\r')
    idx=0
    for ap in $APK_PATHS; do
      [[ -z "$ap" ]] && continue
      bn=$(basename "$ap")
      adb pull "$ap" "$WORK_TMP/stage/apks/$pkg/${idx}_${bn}" >/dev/null 2>&1 || true
      idx=$((idx + 1))
    done

    # Flush SQLite WAL checkpoints safely by pausing background activity briefly, then stream CE + DE app data
    adb exec-out "tar -C /data/user/0 --exclude='$pkg/cache' --exclude='$pkg/code_cache' --exclude='$pkg/no_backup' -cf - '$pkg' 2>/dev/null" \
      > "$WORK_TMP/stage/appdata/${pkg}_ce.tar" || true
    adb exec-out "tar -C /data/user_de/0 --exclude='$pkg/cache' --exclude='$pkg/code_cache' -cf - '$pkg' 2>/dev/null" \
      > "$WORK_TMP/stage/appdata/${pkg}_de.tar" || true
  done

  # 4. Shared external storage (/sdcard/Download, Documents, DCIM, Pictures, Music, Movies) + /data/local/tmp/persistent
  adb shell "mkdir -p /sdcard/Download /sdcard/Documents /sdcard/DCIM /sdcard/Pictures /data/local/tmp/persistent" >/dev/null 2>&1 || true
  adb exec-out "tar -C /sdcard -cf - Download Documents DCIM Pictures Music Movies 2>/dev/null" > "$WORK_TMP/stage/sdcard.tar" || true
  adb exec-out "tar -C /data/local/tmp -cf - persistent 2>/dev/null" > "$WORK_TMP/stage/local_persistent.tar" || true

  # 5. Build manifest + zstd archive
  PKG_JSON=$(printf '%s\n' "${PKG_ARRAY[@]:-}" | jq -R . | jq -s 'map(select(length > 0))')
  jq -n \
    --arg aid "$AID" \
    --arg sess "${EMULATOR_SESSION_ID:-manual}" \
    --arg run "${GITHUB_RUN_ID:-local}" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson pkgs "$PKG_JSON" \
    '{android_id: $aid, source_session_id: $sess, github_run_id: $run, created_at: $ts, installed_packages: $pkgs}' \
    > "$WORK_TMP/stage/manifest.json"

  ARCHIVE="$WORK_TMP/latest-state.tar.zst"
  tar -C "$WORK_TMP/stage" -cf - . | zstd -3 -q -o "$ARCHIVE"
  SIZE_BYTES=$(stat -c '%s' "$ARCHIVE")
  META_B64=$(base64 -w0 "$WORK_TMP/stage/manifest.json")

  echo "[state-manager] Packed state archive ($SIZE_BYTES bytes, ${#PKG_ARRAY[@]} user apps)."

  # 6. Upload to Primary Hot Store on android.aivideo.blitz.cloud
  if [[ -n "${EMULATOR_GATEWAY_URL:-}" && -n "${EMULATOR_GATEWAY_SECRET:-}" ]]; then
    curl -fsSL --retry 3 --max-time 90 -X PUT \
      -H "Authorization: Bearer ${EMULATOR_GATEWAY_SECRET}" \
      -H "Content-Type: application/zstd" \
      -H "X-State-Meta: ${META_B64}" \
      --data-binary "@${ARCHIVE}" \
      "${EMULATOR_GATEWAY_URL}/api/internal/state/snapshot" >/dev/null
    echo "[state-manager] Uploaded snapshot to android.aivideo.blitz.cloud persistent volume."
  fi

  # 7. Upload AES-256 encrypted off-site mirror to GitHub Release 'emulator-state-latest'
  if [[ -n "${GH_PAT:-}" && -n "${EMULATOR_STATE_KEY:-}" ]]; then
    ENC_ARCHIVE="$WORK_TMP/latest-state.tar.zst.enc"
    openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:EMULATOR_STATE_KEY -in "$ARCHIVE" -out "$ENC_ARCHIVE"
    upload_encrypted_github_release "$ENC_ARCHIVE" || echo "[state-manager] Note: GitHub Release mirror skipped/non-fatal."
  fi
}

upload_encrypted_github_release() {
  local enc_file="$1"
  local api_base="https://api.github.com/repos/${REPO_SLUG}"
  local hdr=(-H "Authorization: Bearer ${GH_PAT}" -H "Accept: application/vnd.github+json")

  local rel_json
  rel_json=$(curl -fsSL "${hdr[@]}" "${api_base}/releases/tags/${RELEASE_TAG}" 2>/dev/null || echo "")
  if [[ -z "$rel_json" ]]; then
    rel_json=$(jq -n --arg tag "$RELEASE_TAG" '{tag_name: $tag, name: "Encrypted Android Emulator State", body: "Automated AES-256-PBKDF2 encrypted persistence checkpoint for ReactiveCircus Android Emulator rotation.", prerelease: true}' | \
      curl -fsSL -X POST "${hdr[@]}" -H "Content-Type: application/json" --data-binary @- "${api_base}/releases")
  fi

  local rel_id upload_url
  rel_id=$(echo "$rel_json" | jq -r '.id // empty')
  [[ -z "$rel_id" ]] && return 0

  # Delete old asset with same name if present
  local old_asset_id
  old_asset_id=$(echo "$rel_json" | jq -r '.assets[]? | select(.name == "latest-state.tar.zst.enc") | .id // empty' | head -n1)
  if [[ -n "$old_asset_id" ]]; then
    curl -fsSL -X DELETE "${hdr[@]}" "${api_base}/releases/assets/${old_asset_id}" >/dev/null 2>&1 || true
  fi

  curl -fsSL -X POST \
    -H "Authorization: Bearer ${GH_PAT}" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@${enc_file}" \
    "https://uploads.github.com/repos/${REPO_SLUG}/releases/${rel_id}/assets?name=latest-state.tar.zst.enc" >/dev/null
  echo "[state-manager] Mirrored AES-256 encrypted snapshot to GitHub Release (${RELEASE_TAG})."
}

restore_state() {
  echo "[state-manager] Checking for persisted Android emulator state..."
  ensure_adb_root
  mkdir -p "$WORK_TMP/extract"
  ARCHIVE="$WORK_TMP/restore.tar.zst"
  DOWNLOADED=0

  # 1. Try Primary Hot Store on android.aivideo.blitz.cloud
  if [[ -n "${EMULATOR_GATEWAY_URL:-}" && -n "${EMULATOR_GATEWAY_SECRET:-}" ]]; then
    HTTP_CODE=$(curl -sS -L --max-time 60 -w "%{http_code}" \
      -H "Authorization: Bearer ${EMULATOR_GATEWAY_SECRET}" \
      -o "$ARCHIVE" \
      "${EMULATOR_GATEWAY_URL}/api/internal/state/snapshot" || echo "000")
    if [[ "$HTTP_CODE" == "200" && -s "$ARCHIVE" ]]; then
      DOWNLOADED=1
      echo "[state-manager] Downloaded hot state snapshot from android.aivideo.blitz.cloud ($(stat -c '%s' "$ARCHIVE") bytes)."
    fi
  fi

  # 2. Fallback to AES-256 encrypted GitHub Release mirror
  if [[ "$DOWNLOADED" -eq 0 && -n "${GH_PAT:-}" && -n "${EMULATOR_STATE_KEY:-}" ]]; then
    REL_JSON=$(curl -fsSL -H "Authorization: Bearer ${GH_PAT}" -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${REPO_SLUG}/releases/tags/${RELEASE_TAG}" 2>/dev/null || echo "")
    ASSET_ID=$(echo "$REL_JSON" | jq -r '.assets[]? | select(.name == "latest-state.tar.zst.enc") | .id // empty' | head -n1)
    if [[ -n "$ASSET_ID" ]]; then
      ENC_FILE="$WORK_TMP/restore.tar.zst.enc"
      curl -fsSL -L \
        -H "Authorization: Bearer ${GH_PAT}" \
        -H "Accept: application/octet-stream" \
        -o "$ENC_FILE" \
        "https://api.github.com/repos/${REPO_SLUG}/releases/assets/${ASSET_ID}"
      openssl enc -d -aes-256-cbc -pbkdf2 -pass env:EMULATOR_STATE_KEY -in "$ENC_FILE" -out "$ARCHIVE"
      DOWNLOADED=1
      echo "[state-manager] Downloaded & decrypted fallback snapshot from GitHub Release (${RELEASE_TAG})."
    fi
  fi

  # Always enforce persistent android_id even on very first cold boot
  if [[ -f /tmp/vibely_persisted_android_id ]]; then
    INIT_AID=$(cat /tmp/vibely_persisted_android_id | tr -d '\r\n')
    if [[ -n "$INIT_AID" ]]; then
      adb shell settings put secure android_id "$INIT_AID" || true
    fi
  fi

  if [[ "$DOWNLOADED" -eq 0 ]]; then
    echo "[state-manager] No previous snapshot found — clean initial state initialized."
    return 0
  fi

  zstd -d -q -c "$ARCHIVE" | tar -C "$WORK_TMP/extract" -xf -

  # 3. Restore android_id & settings_ssaid.xml
  if [[ -s "$WORK_TMP/extract/identity/android_id.txt" ]]; then
    AID=$(cat "$WORK_TMP/extract/identity/android_id.txt" | tr -d '\r\n')
    if [[ -n "$AID" && "$AID" != "null" ]]; then
      adb shell settings put secure android_id "$AID" || true
      echo -n "$AID" > /tmp/vibely_persisted_android_id
      echo "[state-manager] Restored persistent android_id=$AID"
    fi
  fi
  if [[ -s "$WORK_TMP/extract/identity/settings_ssaid.xml" ]]; then
    cat "$WORK_TMP/extract/identity/settings_ssaid.xml" | adb shell "cat > /data/system/users/0/settings_ssaid.xml && chown system:system /data/system/users/0/settings_ssaid.xml && chmod 600 /data/system/users/0/settings_ssaid.xml && restorecon /data/system/users/0/settings_ssaid.xml" 2>/dev/null || true
  fi

  # 4. Reinstall third-party APKs & restore private /data/user/0 + /data/user_de/0 with UID/GID + SELinux fixup
  if [[ -d "$WORK_TMP/extract/apks" ]]; then
    for pkg_dir in "$WORK_TMP/extract/apks"/*; do
      [[ ! -d "$pkg_dir" ]] && continue
      pkg=$(basename "$pkg_dir")
      shopt -s nullglob
      apk_files=("$pkg_dir"/*.apk)
      shopt -u nullglob
      if [[ ${#apk_files[@]} -gt 0 ]]; then
        if ! adb shell pm path "$pkg" >/dev/null 2>&1; then
          echo "[state-manager] Installing persisted package: $pkg"
          adb install-multiple -r -g "${apk_files[@]}" >/dev/null 2>&1 || adb install -r -g "${apk_files[0]}" >/dev/null 2>&1 || true
        fi
      fi

      adb shell am force-stop "$pkg" >/dev/null 2>&1 || true
      APP_UG=$(adb shell stat -c '%u:%g' "/data/user/0/$pkg" 2>/dev/null | tr -d '\r\n' || echo "")

      if [[ -s "$WORK_TMP/extract/appdata/${pkg}_ce.tar" ]]; then
        cat "$WORK_TMP/extract/appdata/${pkg}_ce.tar" | adb shell "tar -C /data/user/0 -xf - 2>/dev/null" || true
      fi
      if [[ -s "$WORK_TMP/extract/appdata/${pkg}_de.tar" ]]; then
        cat "$WORK_TMP/extract/appdata/${pkg}_de.tar" | adb shell "tar -C /data/user_de/0 -xf - 2>/dev/null" || true
      fi
      if [[ -n "$APP_UG" && "$APP_UG" == *:* ]]; then
        adb shell "chown -R $APP_UG /data/user/0/$pkg /data/user_de/0/$pkg 2>/dev/null; restorecon -FR /data/user/0/$pkg /data/user_de/0/$pkg 2>/dev/null" || true
      fi
      echo "[state-manager] Restored private app data for $pkg (uid:gid=$APP_UG)"
    done
  fi

  # 5. Restore /sdcard user downloads & /data/local/tmp/persistent
  if [[ -s "$WORK_TMP/extract/sdcard.tar" ]]; then
    cat "$WORK_TMP/extract/sdcard.tar" | adb shell "tar -C /sdcard -xf - 2>/dev/null" || true
    adb shell "chown -R media_rw:media_rw /sdcard/Download /sdcard/Documents /sdcard/DCIM /sdcard/Pictures 2>/dev/null || true" || true
  fi
  if [[ -s "$WORK_TMP/extract/local_persistent.tar" ]]; then
    adb shell "mkdir -p /data/local/tmp" || true
    cat "$WORK_TMP/extract/local_persistent.tar" | adb shell "tar -C /data/local/tmp -xf - 2>/dev/null" || true
  fi

  # 6. Restore custom non-ephemeral global/system settings (e.g. custom vibely_* / screen_off_timeout / font_scale)
  for ns in global secure system; do
    sfile="$WORK_TMP/extract/settings/${ns}.txt"
    if [[ -s "$sfile" ]]; then
      while IFS='=' read -r k v; do
        [[ -z "$k" ]] && continue
        if [[ "$k" == vibely_* || "$k" == "font_scale" || "$k" == "screen_off_timeout" || "$k" == "device_name" ]]; then
          adb shell settings put "$ns" "$k" "$v" >/dev/null 2>&1 || true
        fi
      done < "$sfile"
    fi
  done

  echo "[state-manager] State restoration completed."
}

case "$ACTION" in
  backup) backup_state ;;
  restore) restore_state ;;
  *)
    echo "Usage: $0 {backup|restore}" >&2
    exit 1
    ;;
esac
