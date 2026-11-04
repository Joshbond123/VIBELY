#!/system/bin/sh
# Injected into the AVD's /data/adb/post-fs-data.d/ by root-live.py (host side).
# Magisk runs this as ROOT in the post-fs-data stage, before zygote and before any
# app (including Play services) starts — which is exactly when the device
# identity has to be in place for Play Integrity / app device checks.
#
# It exists because the Magisk *app* cannot be relied on headlessly: 31.x removed
# the interactive root prompt and the "Apps and ADB" mode entirely, and driving
# the 28.x Settings UI from an ADB session is fragile. A hook in the hook
# directory needs no UI, no su, and survives reboots and rotations.

# --- 1. Let the adb shell use the root (needed for live maintenance) ---------
magisk --sqlite "UPDATE settings SET value=2 WHERE key='root_access'" 2>/dev/null
magisk --sqlite "INSERT OR REPLACE INTO policies (uid, process, policy, until, logging, notification) VALUES (2000,'*',2,0,0,0)" 2>/dev/null

# --- 2. Consistent physical-device identity (Pixel 6 / oriole, Android 14) ---
resetprop -n ro.product.model "Pixel 6"
resetprop -n ro.product.manufacturer "Google"
resetprop -n ro.product.brand "google"
resetprop -n ro.product.device "oriole"
resetprop -n ro.product.name "oriole"
resetprop -n ro.product.board "oriole"
resetprop -n ro.product.system.device "oriole"
resetprop -n ro.product.system.model "Pixel 6"
resetprop -n ro.product.vendor.device "oriole"
resetprop -n ro.product.vendor.model "Pixel 6"
resetprop -n ro.product.odm.device "oriole"
resetprop -n ro.product.odm.model "Pixel 6"
resetprop -n ro.build.product "oriole"
resetprop -n ro.build.fingerprint "google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys"
resetprop -n ro.system.build.fingerprint "google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys"
resetprop -n ro.vendor.build.fingerprint "google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys"
resetprop -n ro.bootimage.build.fingerprint "google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys"
resetprop -n ro.build.description "oriole-user 14 UQ1A.240205.002 11224170 release-keys"
resetprop -n ro.build.type "user"
resetprop -n ro.build.tags "release-keys"
resetprop -n ro.build.host "abfarm-release-rbe-64-00045"
resetprop -n ro.build.user "android-build"
resetprop -n ro.debuggable 0
resetprop -n ro.secure 1
resetprop -n ro.kernel.qemu 0
resetprop -n ro.boot.qemu 0
resetprop -n ro.boot.hardware "oriole"
resetprop -n ro.hardware "oriole"
resetprop -n ro.hardware.chipname "oriole"
resetprop -n ro.boot.verifiedbootstate "green"
resetprop -n ro.boot.flash.locked 1
resetprop -n ro.boot.veritymode "enforcing"
resetprop -n ro.com.google.clientidbase "android-google"

# --- 3. Keep the root invisible to the apps that check -----------------------
magisk --sqlite "UPDATE settings SET value=1 WHERE key='zygisk'" 2>/dev/null
magisk --sqlite "UPDATE settings SET value=1 WHERE key='denylist'" 2>/dev/null
for pkg in com.textmeinc.textme com.zhiliaoapp.musically com.android.vending \
           com.google.android.gms com.google.android.gms.persistent com.google.android.gsf; do
  magisk --denylist add "$pkg" "$pkg" 2>/dev/null
done

# --- 4. Storage hygiene: /data hit 100 % full, which broke Keystore ----------
rm -rf /data/tombstones/* /data/anr/* /data/system/dropbox/* /data/local/tmp/* 2>/dev/null

# --- 5. Leave evidence of what actually happened ----------------------------
{
  echo "model=$(getprop ro.product.model)"
  echo "device=$(getprop ro.product.device)"
  echo "fingerprint=$(getprop ro.build.fingerprint)"
  echo "qemu=$(getprop ro.kernel.qemu)"
  df /data | tail -1
} > /data/local/tmp/real-phone.log 2>/dev/null
