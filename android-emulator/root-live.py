#!/usr/bin/env python3
"""Root the PRODUCTION AVD (google_apis_playstore) without wiping it.

Why this exists
---------------
The production image is a Play-certified production build: `adb root` is refused
and `setprop ro.*` is rejected, so the phone can never stop reporting
`sdk_gphone64_x86_64` / `ro.kernel.qemu=1`.  Apps that care (TextMe calls Play
Integrity *and* looks at the build fingerprint) then refuse to register.

The only supported route is the one rootAVD/MagiskOnEmulator use: patch the
emulator's `ramdisk.img` on the host and boot the AVD with `-ramdisk`.  Magisk
then gives us `resetprop` for the read-only identity properties.

This script runs from pre-launch.sh (host side, before the emulator starts) and
ALWAYS leaves a bootable image at RAMDISK_OUT:

  * patch succeeds -> Magisk-patched ramdisk
  * patch fails    -> byte-for-byte copy of the stock ramdisk (today's behaviour)

so a failure here degrades to the current phone instead of a black screen.  It
never touches userdata: the data partition is untouched, every app, login and
setting survives.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import urllib.request

SDK = os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME") or "/usr/local/lib/android/sdk"
AVD_DIR = os.environ.get("AVD_DIR") or os.path.expanduser("~/.android/avd/vibely_pixel6_api34.avd")
RAMDISK_OUT = "/tmp/vibely-ramdisk.img"
WORK = "/tmp/vibely-root-live"
MAGISK_APK = "/tmp/Magisk.apk"
PINNED = [
    "https://github.com/topjohnwu/Magisk/releases/download/v28.1/Magisk-v28.1.apk",
    "https://github.com/topjohnwu/Magisk/releases/download/v27.0/Magisk-v27.0.apk",
]


def log(msg: str) -> None:
    print(f"[root-live] {msg}", flush=True)


def run(cmd, timeout=900, cwd=None):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True,
                          timeout=timeout, cwd=cwd)


def image_ramdisk() -> str | None:
    """Resolve the ramdisk.img the AVD would boot from."""
    sysdir = None
    cfg = os.path.join(AVD_DIR, "config.ini")
    if os.path.exists(cfg):
        for line in open(cfg, encoding="utf-8", errors="replace"):
            if line.startswith("image.sysdir.1="):
                sysdir = line.split("=", 1)[1].strip()
    candidates = []
    if sysdir:
        candidates.append(sysdir if os.path.isabs(sysdir) else os.path.join(SDK, sysdir))
    candidates.append(os.path.join(SDK, "system-images", "android-34", "google_apis_playstore", "x86_64"))
    for c in candidates:
        p = os.path.join(c, "ramdisk.img")
        if os.path.exists(p):
            log(f"system image: {c}")
            return p
    log(f"ERROR: no ramdisk.img found; looked in {candidates}")
    return None


def fetch_magisk() -> bool:
    if os.path.exists(MAGISK_APK) and os.path.getsize(MAGISK_APK) > 5_000_000:
        return True
    try:
        req = urllib.request.Request("https://api.github.com/repos/topjohnwu/Magisk/releases/latest",
                                     headers={"User-Agent": "vibely-root-live"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode())
        for a in data.get("assets", []):
            if a["name"].endswith(".apk"):
                urllib.request.urlretrieve(a["browser_download_url"], MAGISK_APK)
                if os.path.getsize(MAGISK_APK) > 5_000_000:
                    log(f"Magisk {data.get('tag_name')} -> {os.path.getsize(MAGISK_APK)} bytes")
                    return True
    except Exception as exc:  # noqa: BLE001
        log(f"Magisk API resolve failed: {exc}")
    for url in PINNED:
        run(["curl", "-sSL", "-o", MAGISK_APK, url], timeout=900)
        if os.path.exists(MAGISK_APK) and os.path.getsize(MAGISK_APK) > 5_000_000:
            log(f"Magisk pinned download -> {os.path.getsize(MAGISK_APK)} bytes")
            return True
    return False


def patch(src: str) -> bool:
    payload = os.path.join(WORK, "magisk")
    rd = os.path.join(WORK, "rd")
    for d in (payload, rd):
        os.makedirs(d, exist_ok=True)
    run(["unzip", "-o", "-q", MAGISK_APK, "lib/x86_64/*", "assets/stub.apk", "-d", payload], timeout=300)
    libs = os.path.join(payload, "lib", "x86_64")
    if not os.path.isdir(libs):
        log(f"ERROR: APK has no x86_64 payload ({os.listdir(payload)})")
        return False
    bins = {"magiskboot": "libmagiskboot.so", "magiskinit": "libmagiskinit.so",
            "magisk": "libmagisk.so", "init-ld": "libinit-ld.so"}
    for tool, lib in bins.items():
        s = os.path.join(libs, lib)
        if not os.path.exists(s):
            log(f"ERROR: missing {lib} in payload")
            return False
        shutil.copy(s, os.path.join(payload, tool))
        os.chmod(os.path.join(payload, tool), 0o755)

    magiskboot = os.path.join(payload, "magiskboot")
    raw = os.path.join(rd, "ramdisk.cpio")
    run([magiskboot, "decompress", src, raw], cwd=rd)
    if not os.path.exists(raw) or os.path.getsize(raw) < 10_000:
        run(f"gzip -dc '{src}' > ramdisk.cpio", cwd=rd)
    if not os.path.exists(raw) or os.path.getsize(raw) < 10_000:
        log("ERROR: could not decompress stock ramdisk")
        return False
    if run([magiskboot, "cpio", raw, "test"], cwd=rd).returncode != 0:
        log("ERROR: decompressed ramdisk is not a cpio magiskboot understands")
        return False

    shutil.copy(raw, os.path.join(rd, "ramdisk.cpio.orig"))
    with open(os.path.join(rd, "config"), "w") as fh:
        fh.write("KEEPVERITY=false\nKEEPFORCEENCRYPT=false\nRECOVERYMODE=false\nVENDORBOOT=false\n")
    for tool, out in (("magisk", "magisk.xz"), ("init-ld", "init-ld.xz")):
        run([magiskboot, "compress=xz", os.path.join(payload, tool), out], cwd=rd)
    shutil.copy(os.path.join(payload, "magiskinit"), os.path.join(rd, "magiskinit"))
    os.chmod(os.path.join(rd, "magiskinit"), 0o755)

    # Same operation list Magisk's own boot_patch.sh performs.
    ops = [magiskboot, "cpio", raw,
           "add 0750 init magiskinit",
           "mkdir 0750 overlay.d",
           "mkdir 0750 overlay.d/sbin",
           "add 0644 overlay.d/sbin/magisk.xz magisk.xz",
           "add 0644 overlay.d/sbin/init-ld.xz init-ld.xz",
           "patch",
           "backup ramdisk.cpio.orig",
           "mkdir 000 .backup",
           "add 000 .backup/.magisk config"]
    p = run(ops, cwd=rd, timeout=600)
    if p.returncode != 0:
        log(f"ERROR: cpio patch rc={p.returncode} {p.stdout[-400:]} {p.stderr[-400:]}")
        return False

    built = os.path.join(WORK, "ramdisk-patched.img")
    for kind in ("lz4_legacy", "gzip"):
        run([magiskboot, f"compress={kind}", raw, built], cwd=rd, timeout=600)
        if os.path.exists(built) and os.path.getsize(built) > 100_000:
            log(f"patched ramdisk compressed as {kind}: {os.path.getsize(built)} bytes")
            break
    if not (os.path.exists(built) and os.path.getsize(built) > 100_000):
        run(f"gzip -9 -n -c '{raw}' > '{built}'", timeout=300)
    if not (os.path.exists(built) and os.path.getsize(built) > 100_000):
        log("ERROR: patched ramdisk build failed")
        return False
    shutil.copy(built, RAMDISK_OUT)
    return True


def main() -> int:
    src = image_ramdisk()
    if not src:
        return 1
    # Fallback first: whatever happens below, -ramdisk points at a bootable image.
    shutil.copy(src, RAMDISK_OUT)
    log(f"fallback ramdisk in place: {RAMDISK_OUT} ({os.path.getsize(RAMDISK_OUT)} bytes)")
    os.makedirs(WORK, exist_ok=True)
    if not fetch_magisk():
        log("FAIL Magisk APK unavailable - booting the stock ramdisk (phone unchanged)")
        return 1
    if not patch(src):
        log("FAIL ramdisk patch - booting the stock ramdisk (phone unchanged)")
        return 1
    log(f"PASS Magisk ramdisk ready: {RAMDISK_OUT} ({os.path.getsize(RAMDISK_OUT)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
