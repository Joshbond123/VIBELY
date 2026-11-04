#!/usr/bin/env python3
"""Grant `adb shell` (uid 2000) root and prove it — headless.

Magisk 28.1 ships with `root_access = apps-only`, which silently denies `su`
from the adb shell. The only supported way to change that is the Magisk app UI
(Settings -> Superuser access -> Apps and ADB), so this drives the real UI with
uiautomator, exactly as a person would, and then *proves* the result with
`su -c id`.  Nothing is reported as working unless uid=0 actually comes back.

Exit code 0 only when `su -c id` returns uid=0.
"""
from __future__ import annotations

import re
import subprocess
import sys
import time

ADB = "adb"


def sh(cmd: str, timeout: int = 120) -> str:
    p = subprocess.run([ADB, "shell", cmd], capture_output=True, text=True, timeout=timeout)
    return (p.stdout or "") + (p.stderr or "")


def roots() -> bool:
    out = sh("su -c id 2>&1 | head -1")
    return "uid=0" in out


def dump() -> str:
    sh("uiautomator dump /sdcard/ui.xml >/dev/null 2>&1")
    return sh("cat /sdcard/ui.xml 2>/dev/null")


def find(xml: str, *needles: str):
    """Return (cx, cy) of the first node whose text/content-desc contains a needle."""
    best = None
    for m in re.finditer(r"<node[^>]*>", xml or ""):
        tag = m.group(0)
        t = (re.search(r'text="([^"]*)"', tag) or [None, ""])[1] if 'text="' in tag else ""
        d = (re.search(r'content-desc="([^"]*)"', tag) or [None, ""])[1] if 'content-desc="' in tag else ""
        lab = (t or "") + " " + (d or "")
        if not lab.strip():
            continue
        for n in needles:
            if n.lower() in lab.lower():
                b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', tag)
                if b:
                    x1, y1, x2, y2 = map(int, b.groups())
                    best = ((x1 + x2) // 2, (y1 + y2) // 2)
                    break
        if best:
            break
    return best


def tap(*needles: str, wait: float = 3.0, tries: int = 12, scroll: bool = False) -> bool:
    for i in range(tries):
        pos = find(dump(), *needles)
        if pos:
            sh(f"input tap {pos[0]} {pos[1]}")
            time.sleep(wait)
            return True
        if scroll:
            sh("input swipe 540 1800 540 800 300")
        time.sleep(2)
    return False


def main() -> int:
    if roots():
        print("[magisk-grant] su already works")
        return 0

    print("[magisk-grant] opening the Magisk app (28.1 must match the ramdisk daemon)")
    sh("monkey -p com.topjohnwu.magisk -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1")
    time.sleep(12)

    # A first boot can raise the "additional setup" dialog; it would reinstall a
    # different Magisk over our ramdisk, so decline it.
    tap("Cancel", "Not now", wait=3, tries=3)

    if not tap("Settings", wait=6, tries=8):
        print("[magisk-grant] FAIL: could not reach Magisk settings")
        return 1
    taps = 0
    while taps < 4:
        xml = dump()
        if find(xml, "Superuser access"):
            break
        sh("input swipe 540 1900 540 900 350")
        time.sleep(3)
        taps += 1

    if not tap("Superuser access", wait=5, tries=6):
        print("[magisk-grant] FAIL: no 'Superuser access' row (unexpected Magisk build)")
        return 1
    if not tap("Apps and ADB", wait=6, tries=6):
        print("[magisk-grant] FAIL: could not select 'Apps and ADB'")
        return 1
    print("[magisk-grant] Superuser access = Apps and ADB")

    for i in range(10):
        if roots():
            print("[magisk-grant] PASS: su -c id -> uid=0")
            return 0
        time.sleep(4)

    # Apps+ADB still needs the shell uid to be allowed; ask once more.
    sh("su -c id >/dev/null 2>&1 &")
    time.sleep(6)
    tap("Grant", "ALLOW", "Allow", wait=5, tries=4)
    for i in range(6):
        if roots():
            print("[magisk-grant] PASS: su -c id -> uid=0")
            return 0
        time.sleep(4)
    print("[magisk-grant] FAIL: su still denied after granting Apps and ADB")
    return 1


if __name__ == "__main__":
    sys.exit(main())
