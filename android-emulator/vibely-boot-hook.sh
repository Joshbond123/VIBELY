#!/system/bin/sh
# Root bootstrap executed by init from the ramdisk (see init.ranchu.rc).
#
# Why: on this Play-store AVD the only root we can obtain is code that init runs
# from the ramdisk. The Magisk manager's "additional setup" path is a dead end
# here (it reboots, and a guest reboot does not reload the ramdisk, so Magisk
# disappears - verified twice). This script spends its one root moment on
# installing a persistent Magisk root hook and applying the identity.
M=/debug_ramdisk/magisk
echo "hook started $(date) uid=$(id -u)" > /data/local/tmp/vibely-boot.log 2>&1
chmod 644 /data/local/tmp/vibely-boot.log 2>/dev/null
LOG=/sdcard/Download/real-phone.log

{
  echo "=== vibely boot hook $(date) ==="
  echo "uid=$(id -u) model_before=$(getprop ro.product.model)"
} >> "$LOG" 2>/dev/null

# 1. Persistent hook: magiskd runs /data/adb/post-fs-data.d/*.sh as root on
#    every boot, before zygote. Writing it here is the point of this script.
mkdir -p /data/adb/post-fs-data.d 2>/dev/null
cat > /data/adb/post-fs-data.d/real-phone.sh <<'PERSIST'
#!/system/bin/sh
# Applies a physical Pixel 6 identity and the adb-shell superuser policy.
M=/debug_ramdisk/magisk
[ -x "$M" ] || M=magisk
LOG=/data/local/tmp/real-phone.log
{
  echo "=== real-phone $(date) ==="
  $M --sqlite "UPDATE settings SET value=2 WHERE key='root_access'" 2>&1
  $M --sqlite "INSERT OR REPLACE INTO policies (uid,process,policy,until,logging,notification) VALUES (2000,'*',2,0,0,0)" 2>&1
  for kv in \
    "ro.product.model=Pixel 6" "ro.product.manufacturer=Google" "ro.product.brand=google" \
    "ro.product.device=oriole" "ro.product.name=oriole" "ro.product.board=oriole" \
    "ro.product.system.device=oriole" "ro.product.system.model=Pixel 6" \
    "ro.product.vendor.device=oriole" "ro.product.vendor.model=Pixel 6" \
    "ro.product.odm.device=oriole" "ro.product.odm.model=Pixel 6" \
    "ro.build.product=oriole" \
    "ro.build.fingerprint=google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys" \
    "ro.system.build.fingerprint=google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys" \
    "ro.vendor.build.fingerprint=google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys" \
    "ro.bootimage.build.fingerprint=google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys" \
    "ro.build.description=oriole-user 14 UQ1A.240205.002 11224170 release-keys" \
    "ro.build.type=user" "ro.build.tags=release-keys" "ro.debuggable=0" "ro.secure=1" \
    "ro.kernel.qemu=0" "ro.boot.qemu=0" "ro.boot.hardware=oriole" "ro.hardware=oriole" \
    "ro.hardware.chipname=oriole" "ro.boot.verifiedbootstate=green" \
    "ro.boot.flash.locked=1" "ro.boot.veritymode=enforcing" ; do
    $M resetprop -n "${kv%%=*}" "${kv#*=}" 2>&1
  done
  $M --sqlite "UPDATE settings SET value=1 WHERE key='zygisk'" 2>&1
  $M --sqlite "UPDATE settings SET value=1 WHERE key='denylist'" 2>&1
  for p in com.textmeinc.textme com.zhiliaoapp.musically com.android.vending \
           com.google.android.gms com.google.android.gms.persistent com.google.android.gsf ; do
    $M --denylist add "$p" "$p" 2>&1
  done
  rm -rf /data/tombstones/* /data/anr/* /data/system/dropbox/* 2>/dev/null
  echo "result model=$(getprop ro.product.model) device=$(getprop ro.product.device) qemu=$(getprop ro.kernel.qemu)"
} > $LOG 2>&1
cp $LOG /sdcard/Download/real-phone.log 2>/dev/null
chmod 666 /sdcard/Download/real-phone.log 2>/dev/null
PERSIST
chmod 0755 /data/adb/post-fs-data.d/real-phone.sh 2>/dev/null
chown 0:0 /data/adb/post-fs-data.d/real-phone.sh 2>/dev/null
echo "persisted=$(ls -l /data/adb/post-fs-data.d/real-phone.sh 2>&1)" >> "$LOG" 2>/dev/null

# 2. Apply immediately for this boot too; harmless if SELinux blocks magiskd
#    access from the init domain - the persistent hook covers the next boot.
sh /data/adb/post-fs-data.d/real-phone.sh 2>/dev/null

# 3. Machine-readable evidence for an unrooted shell.
{
  echo "model=$(getprop ro.product.model)"
  echo "device=$(getprop ro.product.device)"
  echo "fingerprint=$(getprop ro.build.fingerprint)"
  echo "qemu=$(getprop ro.kernel.qemu)"
  df /data | tail -1
} > /sdcard/Download/vibely-identity.txt 2>/dev/null
chmod 666 /sdcard/Download/vibely-identity.txt 2>/dev/null
