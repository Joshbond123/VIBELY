#!/usr/bin/env bash
# Make the production AVD report and behave like the physical phone it claims to
# be, and keep its data partition from filling up.
#
# Why this is the fix and not a workaround
# ----------------------------------------
# `google_apis_playstore` is a production build: `setprop ro.*` is refused, so a
# plain emulator can only ever answer `sdk_gphone64_x86_64` + `ro.kernel.qemu=1`.
# Apps that check (TextMe requests a Play Integrity token and looks at the build
# fingerprint) then refuse to register ("Unable to Sign Up").
#
# We boot with a Magisk-patched ramdisk (root-live.py, host side, Magisk 28.1 —
# 31.x removed the ADB root mode entirely), which gives us `resetprop` for the
# read-only identity properties, and a Zygisk DenyList so the root itself stays
# invisible to the apps we run.  /data is never formatted: every login, app,
# setting and permission survives.
#
# Secondary, measured problem this script also fixes: /data was at 100 % (0 bytes
# free) on the live phone, which makes Keystore unable to generate key pairs
# ("Integrity key attestation record generation failed") and every app's SQLite
# write fail with SQLITE_FULL.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { echo "[real-phone] $*"; }

# Pre-launch (root-live.py) runs on this same runner: surface its verdict here so
# the hook/ramdisk outcome is visible from the session log, not hours later.
if [[ -f /tmp/root-live.log ]]; then
  log "pre-launch root-live report:"
  sed 's/^/    /' /tmp/root-live.log | tail -20
else
  log "no /tmp/root-live.log - pre-launch root step did not run"
fi

# Never touch `adb root`: on a Play image it bounces adbd and drops the tunnel.
adb wait-for-device
for _ in $(seq 1 60); do
  [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]] && break
  sleep 5
done

# --- 0. Root: match the app to the daemon, then grant adb shell --------------
if ! adb shell "su -c id" 2>/dev/null | grep -q 'uid=0'; then
  DAEMON=$(adb shell "/debug_ramdisk/magisk -v 2>/dev/null" | tr -d '\r')
  if [[ -n "$DAEMON" ]]; then
    log "Magisk daemon in guest: $DAEMON"
    # The app must be the same release as the daemon, otherwise its Settings UI
    # refuses to talk to magiskd and the superuser mode cannot be set.
    if [[ -f /tmp/Magisk.apk ]]; then
      adb install -r -g /tmp/Magisk.apk >/dev/null 2>&1 && log "Magisk app installed from the same release"
    fi
    python3 "$HERE/magisk_grant.py" 2>&1 | sed 's/^/[real-phone] /'
  else
    log "NO ROOT: Magisk ramdisk not active — identity stays unspoofed (stock behaviour)"
  fi
fi

SU=""
for cand in "su -c" "/debug_ramdisk/su -c"; do
  if adb shell "$cand id" 2>/dev/null | grep -q 'uid=0'; then SU="$cand"; break; fi
done

if [[ -z "$SU" ]]; then
  log "reported model: $(adb shell getprop ro.product.model | tr -d '\r') | hardware: $(adb shell getprop ro.hardware | tr -d '\r')"
  log "boot hook files: $(adb shell 'ls -l /init.ranchu.rc /vibely-boot-hook.sh 2>&1 | tr "\n" ";"' | tr -d '\r')"
log "VERIFY model=$(adb shell getprop ro.product.model | tr -d '\r') qemu=$(adb shell getprop ro.kernel.qemu | tr -d '\r') su=absent"
  exit 0
fi
log "root available via: $SU"
R() { adb shell "$SU '$*'" 2>/dev/null | tr -d '\r'; }

# --- 1. Physical-device identity (Pixel 6 / oriole, Android 14, release-keys) --
# Internally consistent on purpose: fingerprint, description, board and the qemu
# flags have to agree, otherwise detection gets *easier*, not harder.
IDENTITY=(
  "ro.product.model|Pixel 6"
  "ro.product.manufacturer|Google"
  "ro.product.brand|google"
  "ro.product.device|oriole"
  "ro.product.name|oriole"
  "ro.product.board|oriole"
  "ro.product.system.device|oriole"
  "ro.product.system.model|Pixel 6"
  "ro.product.vendor.device|oriole"
  "ro.product.vendor.model|Pixel 6"
  "ro.product.odm.device|oriole"
  "ro.product.odm.model|Pixel 6"
  "ro.build.product|oriole"
  "ro.build.fingerprint|google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys"
  "ro.system.build.fingerprint|google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys"
  "ro.vendor.build.fingerprint|google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys"
  "ro.bootimage.build.fingerprint|google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys"
  "ro.build.description|oriole-user 14 UQ1A.240205.002 11224170 release-keys"
  "ro.build.type|user"
  "ro.build.tags|release-keys"
  "ro.build.host|abfarm-release-rbe-64-00045"
  "ro.build.user|android-build"
  "ro.debuggable|0"
  "ro.secure|1"
  "ro.kernel.qemu|0"
  "ro.boot.qemu|0"
  "ro.boot.hardware|oriole"
  "ro.hardware|oriole"
  "ro.hardware.chipname|oriole"
  "ro.boot.verifiedbootstate|green"
  "ro.boot.flash.locked|1"
  "ro.boot.veritymode|enforcing"
  "ro.com.google.clientidbase|android-google"
)
APPLIED=0
for kv in "${IDENTITY[@]}"; do
  k="${kv%%|*}"; v="${kv#*|}"
  R "resetprop -n $k '$v'" >/dev/null
  APPLIED=$((APPLIED+1))
done
log "identity props applied: ${APPLIED}/${#IDENTITY[@]}"

# Persist as a Magisk module (post-fs-data.sh runs as root before zygote, so the
# spoof is in place before any app — including Play services — starts).
MOD=/data/adb/modules/realidentity
SCRIPT=""
for kv in "${IDENTITY[@]}"; do SCRIPT+="resetprop -n '${kv%%|*}' '${kv#*|}'"$'\n'; done
R "mkdir -p $MOD"
R "printf 'id=realidentity\nname=Real phone identity\nversion=2\nversionCode=2\nauthor=vibely\ndescription=Report a physical Pixel 6 identity\n' > $MOD/module.prop"
R "printf '#!/system/bin/sh\n${SCRIPT}' > $MOD/post-fs-data.sh"
R "chmod 755 $MOD/post-fs-data.sh"
log "identity module: $(R "ls /data/adb/modules" | tr '\n' ' ')"

# --- 2. Hide the root that makes this possible --------------------------------
R "magisk --sqlite \"UPDATE settings SET value=1 WHERE key='zygisk'\"" >/dev/null
R "magisk --sqlite \"UPDATE settings SET value=1 WHERE key='denylist'\"" >/dev/null
for pkg in com.textmeinc.textme com.zhiliaoapp.musically com.android.vending \
           com.google.android.gms com.google.android.gms.persistent com.google.android.gsf; do
  R "magisk --denylist add $pkg $pkg" >/dev/null
done
log "zygisk + denylist configured for textme/tiktok/vending/gms/gsf"

# --- 3. Free the data partition (it was 100 % full -> SQLITE_FULL everywhere) --
BEFORE=$(adb shell df /data | tail -1 | awk '{print $4}')
R "logcat -b all -c" >/dev/null
R "rm -rf /data/local/tmp/* /data/tombstones/* /data/anr/* /data/system/dropbox/*" >/dev/null
R "for d in /data/data/*/cache; do rm -rf \"\$d\"/* 2>/dev/null; done" >/dev/null
adb shell pm trim-caches 6000M >/dev/null 2>&1 || true
AFTER=$(adb shell df /data | tail -1 | awk '{print $4}')
log "data free: before=${BEFORE}K after=${AFTER}K"

# --- 4. Evidence (never report an unverified claim) --------------------------
log "boot hook files: $(adb shell 'ls -l /init.ranchu.rc /vibely-boot-hook.sh 2>&1 | tr "\n" ";"' | tr -d '\r')"
log "VERIFY model=$(adb shell getprop ro.product.model | tr -d '\r') brand=$(adb shell getprop ro.product.brand | tr -d '\r') device=$(adb shell getprop ro.product.device | tr -d '\r')"
log "VERIFY hardware=$(adb shell getprop ro.hardware | tr -d '\r') qemu=$(adb shell getprop ro.kernel.qemu | tr -d '\r')"
log "VERIFY fingerprint=$(adb shell getprop ro.build.fingerprint | tr -d '\r')"
log "VERIFY debuggable=$(adb shell getprop ro.debuggable | tr -d '\r') secure=$(adb shell getprop ro.secure | tr -d '\r')"
log "VERIFY df=$(adb shell df /data | tail -1 | tr -s ' ')"
log "VERIFY su=$(adb shell "$SU id" | tr -d '\r' | head -1)"
log "VERIFY hook_ran=$(adb shell 'cat /sdcard/Download/real-phone.log 2>/dev/null | head -3 | tr "\n" ";"' | tr -d '\r')"
