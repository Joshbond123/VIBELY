#!/system/bin/sh
# Root hook executed by init from the ramdisk (see init.ranchu.rc).
#
# Reports everything through system properties: the init domain is not allowed
# to write /data/local/tmp or /sdcard, but it can set vibely.* properties, which
# makes this verifiable from an ordinary adb shell.
setprop vibely.hook.started 1
M=/debug_ramdisk/magisk
[ -x "$M" ] || M=magisk
setprop vibely.hook.magisk "$M"

apply_props() {
  $M resetprop -n ro.product.model "Pixel 6"
  $M resetprop -n ro.product.manufacturer "Google"
  $M resetprop -n ro.product.brand "google"
  $M resetprop -n ro.product.device "oriole"
  $M resetprop -n ro.product.name "oriole"
  $M resetprop -n ro.product.board "oriole"
  $M resetprop -n ro.build.product "oriole"
  $M resetprop -n ro.build.fingerprint "google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys"
  $M resetprop -n ro.system.build.fingerprint "google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys"
  $M resetprop -n ro.vendor.build.fingerprint "google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys"
  $M resetprop -n ro.bootimage.build.fingerprint "google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys"
  $M resetprop -n ro.build.description "oriole-user 14 UQ1A.240205.002 11224170 release-keys"
  $M resetprop -n ro.build.type user
  $M resetprop -n ro.build.tags release-keys
  $M resetprop -n ro.hardware oriole
  $M resetprop -n ro.boot.hardware oriole
  $M resetprop -n ro.kernel.qemu 0
  $M resetprop -n ro.boot.qemu 0
  $M resetprop -n ro.boot.verifiedbootstate green
  $M resetprop -n ro.boot.flash.locked 1
  $M resetprop -n ro.boot.veritymode enforcing
}

apply_props
setprop vibely.hook.model "$(getprop ro.product.model)"
setprop vibely.hook.device "$(getprop ro.product.device)"
setprop vibely.hook.qemu "$(getprop ro.kernel.qemu)"

# Let adb shell use su ("Apps and ADB" + an explicit allow row for uid 2000).
$M --sqlite "UPDATE settings SET value=2 WHERE key='root_access'" 2>/dev/null
$M --sqlite "INSERT OR REPLACE INTO policies (uid,process,policy,until,logging,notification) VALUES (2000,'*',2,0,0,0)" 2>/dev/null
setprop vibely.hook.sqlite "$?"

# Keep that root invisible to the apps that check for it.
$M --sqlite "UPDATE settings SET value=1 WHERE key='zygisk'" 2>/dev/null
$M --sqlite "UPDATE settings SET value=1 WHERE key='denylist'" 2>/dev/null
for p in com.textmeinc.textme com.zhiliaoapp.musically com.android.vending \
         com.google.android.gms com.google.android.gms.persistent com.google.android.gsf ; do
  $M --denylist add "$p" "$p" 2>/dev/null
done
setprop vibely.hook.done 1

# Persist for later boots too, if /data/adb is writable from here.
mkdir -p /data/adb/post-fs-data.d 2>/dev/null && cp /vibely-boot-hook.sh /data/adb/post-fs-data.d/real-phone.sh 2>/dev/null
setprop vibely.hook.persisted "$?"
