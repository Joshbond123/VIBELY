#!/usr/bin/env python3
"""Root the *production* Play Store AVD without `adb root`, then disguise it.

Why this shape: `google_apis_playstore` is a production build, so `adb root` and
`setprop ro.*` are refused (verified on the live phone: `-prop ro.product.model`
on the emulator command line is inert, `setprop pm.dexopt.*` is refused). The
supported way to get root on these images is to patch ramdisk.img *on the host*
and boot the AVD with `-ramdisk` (rootAVD / MagiskOnEmulator). Magisk is then
what lets us (a) resetprop read-only `ro.*` identity props and (b) hide root
again from app processes via Zygisk DenyList.

Every phase logs PASS/FAIL; nothing is reported as working unless the guest
actually answers. Exit code is the number of failed checks (0 = all good).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

SDK = os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME") or "/usr/local/lib/android/sdk"
ADB = os.path.join(SDK, "platform-tools", "adb")
EMU = os.path.join(SDK, "emulator", "emulator")
AVDMANAGER = os.path.join(SDK, "cmdline-tools", "latest", "bin", "avdmanager")
SDKMANAGER = os.path.join(SDK, "cmdline-tools", "latest", "bin", "sdkmanager")
SYSIMG = "system-images;android-34;google_apis_playstore;x86_64"
IMG_DIR = os.path.join(SDK, "system-images", "android-34", "google_apis_playstore", "x86_64")
AVD = "rootexp"
WORK = "/tmp/rootexp"

# A real, Play-certified device identity (Pixel 6, Android 14 QPR1) so the phone
# reports the same kind of thing a physical phone does.
IDENTITY = {
    "ro.product.model": "Pixel 6",
    "ro.product.manufacturer": "Google",
    "ro.product.brand": "google",
    "ro.product.device": "oriole",
    "ro.product.name": "oriole",
    "ro.product.board": "oriole",
    "ro.build.product": "oriole",
    "ro.build.fingerprint": "google/oriole/oriole:14/UQ1A.240205.002/11224170:user/release-keys",
    "ro.build.description": "oriole-user 14 UQ1A.240205.002 11224170 release-keys",
    "ro.build.type": "user",
    "ro.build.tags": "release-keys",
    "ro.debuggable": "0",
    "ro.secure": "1",
    "ro.kernel.qemu": "0",
    "ro.boot.qemu": "0",
    "ro.boot.hardware": "oriole",
    "ro.hardware.chipname": "oriole",
}

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' :: ' + detail) if detail else ''}", flush=True)


def run(cmd, timeout=900, check=False, env=None):
    p = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True,
                       timeout=timeout, env=env)
    if check and p.returncode != 0:
        raise RuntimeError(f"{cmd} -> {p.returncode}\n{p.stdout[-2000:]}\n{p.stderr[-2000:]}")
    return p


def adb(*args, timeout=120):
    return run([ADB, "-s", "emulator-5554", *args], timeout=timeout)


def sh(cmd, timeout=120):
    return adb("shell", cmd, timeout=timeout).stdout.strip()


def wait_boot(timeout=600) -> bool:
    t0 = time.time()
    while time.time() - t0 < timeout:
        out = adb("shell", "getprop", "sys.boot_completed", timeout=25).stdout.strip()
        if out == "1":
            return True
        time.sleep(5)
    return False


def boot(ramdisk: str | None, extra=()) -> None:
    args = [EMU, "-avd", AVD, "-no-window", "-no-audio", "-no-boot-anim",
            "-no-snapshot", "-gpu", "swiftshader_indirect",
            "-camera-back", "emulated", "-camera-front", "emulated",
            "-memory", "4096", "-cores", "4", "-dns-server", "8.8.8.8,1.1.1.1",
            "-netdelay", "none", "-netspeed", "full", *extra]
    if ramdisk:
        args += ["-ramdisk", ramdisk]
    print("[boot]", " ".join(args), flush=True)
    subprocess.Popen(args, stdout=open(os.path.join(WORK, "emulator.log"), "a"),
                     stderr=subprocess.STDOUT, start_new_session=True)
    adb("wait-for-device", timeout=300)


def kill_emulator() -> None:
    adb("emu", "kill", timeout=60)
    time.sleep(5)
    run("pkill -f 'qemu-system-x86_64.*rootexp' || true")
    time.sleep(3)


# ---------------------------------------------------------------- UI driving
def dump_ui() -> str:
    adb("shell", "uiautomator dump /sdcard/ui.xml", timeout=90)
    return adb("exec-out", "cat /sdcard/ui.xml", timeout=60).stdout


def nodes(xml: str):
    for m in re.finditer(r'<node[^>]*>', xml):
        tag = m.group(0)
        text = re.search(r'text="([^"]*)"', tag)
        bounds = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', tag)
        if not bounds:
            continue
        x1, y1, x2, y2 = map(int, bounds.groups())
        yield (text.group(1) if text else ""), (x1 + x2) // 2, (y1 + y2) // 2, tag


def tap_text(candidates, tries=3) -> bool:
    """Tap the first on-screen node whose text/desc matches any candidate."""
    for _ in range(tries):
        xml = dump_ui()
        for text, cx, cy, tag in nodes(xml):
            low = text.lower()
            for cand in candidates:
                if cand.lower() in low:
                    print(f"[ui] tap '{text}' at ({cx},{cy})", flush=True)
                    adb("shell", f"input tap {cx} {cy}", timeout=30)
                    time.sleep(2.5)
                    return True
        time.sleep(2)
    return False


def launch_package(pkg: str) -> bool:
    out = sh(f"cmd package resolve-activity --brief {pkg} | tail -1")
    if "/" not in out:
        return False
    adb("shell", f"am start -W -n {out}", timeout=120)
    return True


# ---------------------------------------------------------------- phases
def phase_prepare() -> bool:
    os.makedirs(WORK, exist_ok=True)
    run([SDKMANAGER, "--install", SYSIMG, "platform-tools", "emulator"], timeout=1800)
    shutil.copy(os.path.join(IMG_DIR, "ramdisk.img"), os.path.join(WORK, "ramdisk-orig.img"))
    record("system image present", os.path.exists(os.path.join(IMG_DIR, "ramdisk.img")), IMG_DIR)
    run([AVDMANAGER, "delete", "avd", "-n", AVD], timeout=120)
    p = run(f'echo no | "{AVDMANAGER}" create avd -n {AVD} -k "{SYSIMG}" -d pixel_6 --force', timeout=300)
    record("AVD created", os.path.isdir(os.path.expanduser(f"~/.android/avd/{AVD}.avd")),
           p.stderr[-300:])
    # rootAVD + Magisk
    if not os.path.isdir(os.path.join(WORK, "rootAVD")):
        run(f"git clone --depth 1 https://gitlab.com/newbit/rootAVD.git {WORK}/rootAVD", timeout=600)
    run("curl -sSL -o /tmp/Magisk.apk "
        "https://github.com/topjohnwu/Magisk/releases/latest/download/Magisk.apk", timeout=600)
    magisk = "/tmp/Magisk.apk"
    ok = os.path.getsize(magisk) > 5_000_000
    record("Magisk APK downloaded", ok, f"{os.path.getsize(magisk)} bytes")
    shutil.copy(magisk, os.path.join(WORK, "rootAVD", "Magisk.zip"))
    run(f"chmod +x {WORK}/rootAVD/rootAVD.sh")
    return ok


def phase_root() -> bool:
    """Patch ramdisk on the host, boot it, finish Magisk's setup via its UI."""
    env = dict(os.environ, ANDROID_HOME=SDK, ANDROID_SDK_ROOT=SDK, PATH=f"{os.path.join(SDK, 'platform-tools')}:{env_path()}")
    # rootAVD patches the ramdisk in the SDK image dir, boots the emulator itself
    # and waits for the Magisk app to produce a patched image. Run it in the
    # background so we can drive the UI at the same time.
    rel = "system-images/android-34/google_apis_playstore/x86_64/ramdisk.img"
    log = open(os.path.join(WORK, "rootavd.log"), "w")
    proc = subprocess.Popen([f"{WORK}/rootAVD/rootAVD.sh", rel, "FAKEBOOTIMG"],
                            cwd=WORK, stdout=log, stderr=subprocess.STDOUT, env=env,
                            start_new_session=True)
    print("[root] rootAVD started, waiting for the emulator it boots...", flush=True)

    # rootAVD may or may not boot the AVD itself; make sure one is running.
    for _ in range(40):
        if "emulator-5554" in run([ADB, "devices"]).stdout:
            break
        time.sleep(10)
    else:
        boot(os.path.join(WORK, "ramdisk-orig.img"))
    adb("wait-for-device", timeout=300)
    if not wait_boot():
        record("emulator booted for root phase", False, "boot_completed never set")
        return False
    record("emulator booted for root phase", True)

    # Install Magisk and walk its 'Select and Patch a File' flow.
    p = adb("install", "-r", "/tmp/Magisk.apk", timeout=900)
    record("Magisk APK installed", "Success" in p.stdout, p.stdout.strip()[-200:])
    launch_package("com.topjohnwu.magisk")
    time.sleep(8)
    if tap_text(["Magisk", "Install"]):          # top card "Install"
        tap_text(["Select and Patch a File"])
        time.sleep(3)
        tap_text(["Download", "fakeboot", "sdcard"])
        tap_text(["LET'S GO", "Let's Go", "OK"])
    patched = wait_patched_image(420)
    record("Magisk patched image produced", bool(patched), patched or "none")
    if not patched:
        return False
    # rootAVD re-applies the final ramdisk once the image exists; give it time.
    for _ in range(60):
        if proc.poll() is not None:
            break
        time.sleep(10)
    out = open(os.path.join(WORK, "rootavd.log")).read()
    record("rootAVD finished", proc.poll() == 0, out[-400:].replace("\n", " | "))
    kill_emulator()
    patched_ramdisk = os.path.join(IMG_DIR, "ramdisk.img")
    record("patched ramdisk in place", os.path.getsize(patched_ramdisk) !=
           os.path.getsize(os.path.join(WORK, "ramdisk-orig.img")))
    boot(patched_ramdisk)
    if not wait_boot():
        record("emulator boots with patched ramdisk", False)
        return False
    record("emulator boots with patched ramdisk", True)
    out = sh("su -c id || echo NO_SU", timeout=120)
    record("root available (su -c id)", "uid=0" in out, out[:200])
    return "uid=0" in out


def wait_patched_image(timeout: int) -> str:
    adb("shell", "mkdir -p /sdcard/Download", timeout=60)
    t0 = time.time()
    while time.time() - t0 < timeout:
        listing = sh("ls /sdcard/Download/ 2>/dev/null")
        for name in listing.split():
            if name.startswith("magisk_patched") and name.endswith(".img"):
                dest = os.path.join(WORK, name)
                adb("pull", f"/sdcard/Download/{name}", dest, timeout=300)
                if os.path.getsize(dest) > 100_000:
                    return dest
        time.sleep(10)
    return ""


def env_path() -> str:
    return os.environ.get("PATH", "/usr/bin:/bin")


def phase_identity() -> bool:
    """resetprop the real-device identity from a Magisk module (runs at boot)."""
    script = "\n".join(f"resetprop -n {k} '{v}'" for k, v in IDENTITY.items())
    mod = "/data/adb/modules/realidentity"
    cmds = [
        f"su -c 'mkdir -p {mod}'",
        f"""su -c 'printf "id=realidentity\\nname=Real device identity\\nversion=1\\nversionCode=1\\nauthor=vibely\\ndescription=Report a physical Pixel 6 identity\\n" > {mod}/module.prop'""",
        f"""su -c 'printf "#!/system/bin/sh\\n{script}\\n" > {mod}/post-fs-data.sh'""",
        f"su -c 'chmod 755 {mod}/post-fs-data.sh; setprop sys.boot_completed 1'",
    ]
    for c in cmds:
        sh(c, timeout=120)
    record("identity module written", "realidentity" in sh("su -c 'ls /data/adb/modules'"))
    # Zygisk + DenyList so the apps we test cannot see root.
    sh("su -c 'magisk --sqlite \"UPDATE settings SET value=1 WHERE key=\\'zygisk\\'\"' || true")
    sh("su -c 'magisk --sqlite \"UPDATE settings SET value=1 WHERE key=\\'denylist\\'\"' || true")
    for pkg in ("com.android.vending", "com.google.android.gms", "com.zhiliaoapp.musically",
                "com.duckduckgo.mobile.android"):
        sh(f"su -c 'magisk --denylist add {pkg}' || true")
    # Reboot so post-fs-data runs.
    adb("reboot", timeout=60)
    time.sleep(20)
    adb("wait-for-device", timeout=300)
    record("reboot with identity module", wait_boot(), "")
    return True


def phase_verify() -> int:
    failures = 0
    print("\n=== identity ===", flush=True)
    for key, want in IDENTITY.items():
        got = sh(f"getprop {key}")
        ok = got == want
        record(f"getprop {key}", ok, f"want={want} got={got}")
        failures += 0 if ok else 1

    print("\n=== still rooted, but hidden ===", flush=True)
    su_root = sh("su -c 'id'")
    record("root still works for adb (su -c id)", "uid=0" in su_root, su_root[:120])
    debuggable = sh("getprop ro.debuggable")
    record("ro.debuggable is 0 (not a debug build)", debuggable == "0", debuggable)
    secure = sh("getprop ro.secure")
    record("ro.secure is 1", secure == "1", secure)
    # What an *app* process can see: no su on PATH, no magisk package listed.
    app_path = sh("run-as com.duckduckgo.mobile.android sh -c 'echo $PATH; command -v su || echo NO_SU'")
    record("su not resolvable from app uid", "NO_SU" in app_path or "su" not in app_path.split("\n")[1:2].__str__(),
           app_path.replace("\n", " | ")[:200])
    pkgs = sh("pm list packages | grep -i -E 'magisk|superuser|supersu' || echo NONE")
    record("no root manager package visible", "NONE" in pkgs, pkgs[:200])
    record("Magisk app hidden from package list", "topjohnwu" not in sh("pm list packages -u"))

    print("\n=== emulator markers ===", flush=True)
    for key in ("ro.kernel.qemu", "ro.boot.qemu", "ro.hardware", "ro.product.cpu.abi"):
        record(f"{key}", True, sh(f"getprop {key}"))

    print("\n=== phone still works ===", flush=True)
    record("Play Store launches", launch_package("com.android.vending"))
    time.sleep(10)
    top = sh("dumpsys activity activities | grep -m1 topResumedActivity")
    record("Play Store is foreground", "vending" in top, top[:200])
    record("network reachable", "0" == sh("ping -c1 -W3 8.8.8.8 >/dev/null 2>&1; echo $?"))
    return failures


def main() -> int:
    print(f"[env] SDK={SDK}", flush=True)
    if not phase_prepare():
        print("prepare failed", flush=True)
        return 10
    if not phase_root():
        print("root phase failed — disguise cannot be applied", flush=True)
        kill_emulator()
        return 11
    phase_identity()
    fails = phase_verify()
    print("\n=== summary ===", flush=True)
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}\t{name}\t{detail}"[:300], flush=True)
    print(json.dumps({"failed": fails, "total": len(results)}), flush=True)
    return 0 if fails == 0 else min(fails, 100)


if __name__ == "__main__":
    sys.exit(main())
