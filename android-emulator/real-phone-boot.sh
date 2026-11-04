#!/system/bin/sh
# Runs from the emulator ramdisk via an init.rc trigger, as root, once
# sys.boot_completed=1 (Magisk is already up by then, so `magisk resetprop` and
# `magisk --sqlite` both work). Injected by root-live.py.
#
# This exists because the AVD's userdata is a QCOW2 image, so the identity hook
# cannot be dropped into /data/adb/post-fs-data.d offline, and the Magisk app is
# not usable headlessly (31.x removed ADB root; 28.x has no launchable activity
# on this image). The ramdisk is the one place we fully control before boot.
M=/debug_ramdisk/magisk
[ -x "$M" ] || M=magisk

# 1. Root newest-first: let adb shell use su (Magisk 28.x "Apps and ADB" mode).
$M --sqlite "UPDATE settings SET value=2 WHERE key='root_access'" 2>/dev/null
$M --sqlite "INSERT OR REPLACE INTO policies (uid, process, policy, until, logging, notification) VALUES (2000,'*',2,0,0,0)" 2>/dev/null

# 2. Physical-device identity, applied before any app process reads it.
for kv in \
  "ro.product.model=Pixel 6" \
  "ro.product.manufacturer=Google" \
  "ro.product.brand=google" \
  "ro.product.device=oriole" \
  "ro.product.name=oriole" \
  "ro.product.board=oriole" \
  "ro.product.system.device=oriole" \
  "ro.product.system.model=Pixel 6" \
  "ro.product.vendor.device=oriole" \
  "ro.product.vendor.model=Pixel 6" \
  "ro.product.odm.device=oriole" \
  "ro.product.odm.model=Pixel 6" \
  "ro.build.product=oriole" \
  "ro.build.fingerprint=google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys" \
  "ro.system.build.fingerprint=google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys" \
  "ro.vendor.build.fingerprint=google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys" \
  "ro.bootimage.build.fingerprint=google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys" \
  "ro.build.description=oriole-user 14 UQ1A.240205.002 11224170 release-keys" \
  "ro.build.type=user" \
  "ro.build.tags=release-keys" \
  "ro.debuggable=0" \
  "ro.secure=1" \
  "ro.kernel.qemu=0" \
  "ro.boot.qemu=0" \
  "ro.boot.hardware=oriole" \
  "ro.hardware=oriole" \
  "ro.hardware.chipname=oriole" \
  "ro.boot.verifiedbootstate=green" \
  "ro.boot.flash.locked=1" \
  "ro.boot.veritymode=enforcing" \
  "ro.com.google.clientidbase=android-google" ; do
  $M resetprop -n "${kv%%=*}" "${kv#*=}" 2>/dev/null
done

# 3. Keep that root invisible to the apps that check for it.
$M --sqlite "UPDATE settings SET value=1 WHERE key='zygisk'" 2>/dev/null
$M --sqlite "UPDATE settings SET value=1 WHERE key='denylist'" 2>/dev/null
for pkg in com.textmeinc.textme com.zhiliaoapp.musically com.android.vending \
           com.google.android.gms com.google.android.gms.persistent com.google.android.gsf ; do
  $M --denylist add "$pkg" "$pkg" 2>/dev/null
done

# 4. Storage hygiene (/data hit 100 % full, which broke Keystore attestation).
rm -rf /data/tombstones/* /data/anr/* /data/system/dropbox/* 2>/dev/null

# 5. Evidence, readable from an unrooted adb shell.
{
  echo "model=$(getprop ro.product.model)"
  echo "device=$(getprop ro.product.device)"
  echo "fingerprint=$(getprop ro.build.fingerprint)"
  echo "qemu=$(getprop ro.kernel.qemu)"
  df /data | tail -1
} > /sdcard/Download/real-phone.log 2>/dev/null
