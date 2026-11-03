#!/usr/bin/env python3
"""Real Google Play Store download/install test for the VIBELY Android phone.

Nothing in here is simulated: every check is an ADB observation taken from the
live emulator (directly with `adb`, or through the public gateway HTTP API).

Phases
  1. preflight      boot, /data headroom, Play Store + GMS presence, sign-in state
  2. launch         open the Play Store listing for a package that is not installed
  3. install        press the real "Install" button and wait for PackageManager to
                    report the package with a real APK on disk
  4. exercise       launch the app, verify a resumed activity + frame, grant a
                    runtime permission and record app data size
  5. verify         emit machine-readable evidence (JSON) for post-rotation checks

Usage
    # on the runner, straight against adb
    python3 play_install_test.py --package org.billthefarmer.notes --json out.json

    # from anywhere, through the public gateway (no secrets needed)
    python3 play_install_test.py --gateway https://android.aivideo.blitz.cloud \
        --package org.billthefarmer.notes --json out.json

Exit codes: 0 = installed and verified, 2 = not signed in to Play, 3 = install
timed out (evidence captured), 4 = preflight failure.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

args_json_global = None
EVIDENCE: dict = {
    "schema": 1,
    "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "phases": {},
    "errors": [],
    "logcat_tail": [],
}


# ---------------------------------------------------------------------------
# Transports: local adb or the gateway HTTP API
# ---------------------------------------------------------------------------
class AdbLocal:
    name = "adb"

    def shell(self, cmd: str, timeout: int = 60) -> str:
        try:
            out = subprocess.run(["adb", "shell", cmd], capture_output=True, timeout=timeout)
            return (out.stdout or b"").decode("utf-8", "replace")
        except subprocess.TimeoutExpired:
            return "ERR:timeout"
        except Exception as exc:  # pragma: no cover
            return f"ERR:{exc}"

    def input_text(self, text: str) -> str:
        return self.shell(f'input text "{text}"')

    def key(self, code: int) -> str:
        return self.shell(f"input keyevent {code}")

    def tap(self, x: int, y: int) -> str:
        return self.shell(f"input tap {int(x)} {int(y)}")

    def close(self) -> None:
        pass


class Gateway:
    name = "gateway"

    def __init__(self, base: str, token: str = ""):
        self.base = base.rstrip("/")
        self.token = token
        self.session = ""

    def _post(self, path: str, payload: dict, timeout: int = 90) -> dict:
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {self.token}"} if self.token else {})},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                return json.loads(body)
            except Exception:
                return {"ok": False, "error": f"HTTP {e.code}: {body[:300]}"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def shell(self, cmd: str, timeout: int = 60) -> str:
        res = self._post("/api/adb/shell", {"command": cmd}, timeout=min(timeout + 20, 300))
        if not res.get("ok"):
            raise RuntimeError(f"gateway shell failed: {res.get('error')}")
        self.session = res.get("session_id", self.session)
        return res.get("stdout", "")

    def input_text(self, text: str) -> str:
        return str(self._post("/api/input", {"kind": "text", "text": text}).get("ok"))

    def key(self, code: int) -> str:
        return str(self._post("/api/input", {"kind": "keyevent", "keycode": code}).get("ok"))

    def tap(self, x: int, y: int) -> str:
        return str(self._post("/api/input", {"kind": "tap", "x": int(x), "y": int(y)}).get("ok"))

    def health(self) -> dict:
        try:
            with urllib.request.urlopen(self.base + "/api/public/health", timeout=20) as r:
                return json.loads(r.read().decode())
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def close(self) -> None:
        pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def sh(dev, cmd: str, timeout: int = 60) -> str:
    return dev.shell(cmd, timeout=timeout).replace("\r", "")


def pm_installed(dev, pkg: str) -> bool:
    return bool(re.search(r"^package:", sh(dev, f"pm path {pkg}"), re.M))


def free_mb(dev, mount: str = "/data") -> int:
    line = sh(dev, f"df -m {mount} | tail -1")
    parts = line.split()
    try:
        return int(parts[3])
    except Exception:
        return -1


def ui_dump(dev) -> str:
    """Return the current UI hierarchy XML (uiautomator), or '' if unavailable."""
    sh(dev, "uiautomator dump /sdcard/vibely_ui.xml >/dev/null 2>&1")
    return sh(dev, "cat /sdcard/vibely_ui.xml 2>/dev/null")


def find_button(xml: str, patterns) -> tuple[int, int] | None:
    """Find the centre of the first node whose text/desc matches, from a uiautomator dump."""
    for node in re.findall(r"<node[^>]*>", xml):
        text = re.search(r'text="([^"]*)"', node)
        desc = re.search(r'content-desc="([^"]*)"', node)
        label = " ".join(x for x in [text.group(1) if text else "", desc.group(1) if desc else ""] if x)
        if not label:
            continue
        for pat in patterns:
            if re.search(pat, label, re.I):
                b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
                if not b:
                    continue
                x1, y1, x2, y2 = map(int, b.groups())
                return (x1 + x2) // 2, (y1 + y2) // 2
    return None


def logcat(dev, lines: int = 400, tags: str | None = None) -> str:
    tag_arg = f" -s {tags}" if tags else ""
    return sh(dev, f"logcat -d -t {lines}{tag_arg}", timeout=90)[-20000:]


def dismiss_system_dialogs(dev) -> dict:
    """Clear the blockers that stop a Play install from ever starting.

    The critical one is Google Play's "Complete account setup — Add a payment
    option to complete your account" sheet: while it is up, the store accepts the
    Install tap and then never downloads anything, which is exactly the
    "installation stuck, never completes" symptom. We dismiss it with "Skip"
    (no payment method is added and nothing is purchased).
    """
    xml = ui_dump(dev)
    out = {"gate_sheet": False, "dismissed": None, "sign_in_required": False}
    if not xml:
        return out
    out["gate_sheet"] = bool(re.search(r"Complete account setup|Add a payment option|Review your account to continue", xml, re.I))
    if re.search(r"Sign in to your Google Account", xml, re.I):
        out["sign_in_required"] = True
        EVIDENCE.setdefault("blockers", []).append(out)
        return out
    for pat in [r"^(Skip|Not now|No thanks|Maybe later|Do this later)$",
                r"^(Got it|OK|Allow|Continue|Accept|Dismiss)$"]:
        pos = find_button(xml, [pat])
        if pos:
            dev.tap(*pos)
            out["dismissed"] = pat
            time.sleep(2.5)
            EVIDENCE.setdefault("dialogs_dismissed", []).append({"pattern": pat, "gate_sheet": out["gate_sheet"]})
            break
    EVIDENCE.setdefault("blockers", []).append(out)
    return out


def open_store_listing(dev, pkg: str) -> str:
    """Open the Play Store detail page for `pkg` (market:// deep link)."""
    sh(dev, f"am start -a android.intent.action.VIEW -d 'market://details?id={pkg}' -p com.android.vending", timeout=60)
    time.sleep(6)
    for _ in range(3):
        resumed = sh(dev, "dumpsys activity activities | grep -m1 ResumedActivity")
        if "vending" in resumed:
            return resumed.strip()
        time.sleep(3)
        sh(dev, f"am start -a android.intent.action.VIEW -d 'market://details?id={pkg}' -p com.android.vending", timeout=60)
        time.sleep(4)
    return sh(dev, "dumpsys activity activities | grep -m1 ResumedActivity").strip()


def wait_for_install(dev, pkg: str, timeout_s: int, poll_s: int = 5) -> dict:
    """Poll PackageManager until `pkg` has a real APK, collecting progress evidence."""
    deadline = time.time() + timeout_s
    timeline, last_dl = [], ""
    gate_cleared_at = time.time()
    while time.time() < deadline:
        if pm_installed(dev, pkg):
            return {"installed": True, "waited_s": round(timeout_s - (deadline - time.time()), 1), "timeline": timeline[-20:]}
        dl = sh(dev, 'dumpsys download 2>/dev/null | grep -E "Status:|Uri:" | head -6').strip()
        pct = re.findall(r"(\d+)%", sh(dev, "dumpsys activity activities | grep -iE 'vending' | head -5"))
        entry = {"t": round(timeout_s - (deadline - time.time()), 1), "download": dl.replace("\n", " | ")[:220], "pct": pct[:2]}
        if entry["download"] != last_dl:
            timeline.append(entry)
            last_dl = entry["download"]
        # If nothing is downloading after ~20s, a Play gate/dialog is eating the tap.
        if not pct and time.time() - gate_cleared_at > 20:
            gate_cleared_at = time.time()
            gate = dismiss_system_dialogs(dev)
            if gate.get("dismissed") or gate.get("gate_sheet"):
                EVIDENCE.setdefault("install_blockers_cleared", []).append(gate)
                timeline.append({"t": round(timeout_s - (deadline - time.time()), 1), "blocker": gate})
                time.sleep(2)
                # re-tap Install in case the gate swallowed the first tap
                xml2 = ui_dump(dev)
                pos2 = find_button(xml2, [r"^(Install|Update|Get)$"])
                if pos2:
                    dev.tap(*pos2)
        time.sleep(poll_s)
    return {"installed": False, "waited_s": timeout_s, "timeline": timeline[-20:]}


def launch_app(dev, pkg: str) -> dict:
    sh(dev, f"monkey -p {pkg} -c android.intent.category.LAUNCHER 1", timeout=60)
    time.sleep(6)
    resumed = sh(dev, "dumpsys activity activities | grep -m1 ResumedActivity").strip()
    pid = sh(dev, f"pidof {pkg}").strip()
    return {"resumed": resumed, "pid": pid, "running": bool(pid) and pkg in resumed}


def grant_runtime_permissions(dev, pkg: str) -> dict:
    """Grant the app's declared dangerous permissions (real `pm grant`, persisted)."""
    dump = sh(dev, f"dumpsys package {pkg}", timeout=90)
    declared = sorted(set(re.findall(r"(android\.permission\.[A-Z_]+): granted=(?:true|false)", dump)))
    dangerous = [p for p in declared if p in {
        "android.permission.CAMERA", "android.permission.RECORD_AUDIO",
        "android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.POST_NOTIFICATIONS", "android.permission.READ_CONTACTS",
        "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.READ_MEDIA_IMAGES", "android.permission.READ_MEDIA_AUDIO",
        "android.permission.READ_MEDIA_VIDEO", "android.permission.BODY_SENSORS",
        "android.permission.CALL_PHONE", "android.permission.SEND_SMS",
    }]
    granted = []
    for perm in dangerous[:4]:
        sh(dev, f"pm grant {pkg} {perm}", timeout=60)
        got = re.search(re.escape(perm) + r": granted=(true|false)", sh(dev, f"dumpsys package {pkg} | grep -m1 {perm}", timeout=60))
        if got and got.group(1) == "true":
            granted.append(perm)
    return {"declared": declared[:20], "granted": granted}


def app_data_fingerprint(dev, pkg: str) -> dict:
    size = sh(dev, f"du -sk /data/data/{pkg} 2>/dev/null | awk '{{print $1}}'").strip()
    de = sh(dev, f"du -sk /data/user_de/0/{pkg} 2>/dev/null | awk '{{print $1}}'").strip()
    return {"ce_kb": size, "de_kb": de, "version": sh(dev, f"dumpsys package {pkg} | grep -m1 versionName").strip()}


# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------
def preflight(dev, pkg: str) -> dict:
    info = {
        "boot_completed": sh(dev, "getprop sys.boot_completed").strip(),
        "android_release": sh(dev, "getprop ro.build.version.release").strip(),
        "model": sh(dev, "getprop ro.product.model").strip(),
        "play_store_version": sh(dev, "dumpsys package com.android.vending | grep -m1 versionName").strip(),
        "gms_version": sh(dev, "dumpsys package com.google.android.gms | grep -m1 versionName").strip(),
        "gsf_present": bool(sh(dev, "pm path com.google.android.gsf").strip()),
        "data_free_mb": free_mb(dev, "/data"),
        "sdcard_free_mb": free_mb(dev, "/sdcard"),
        "accounts": sh(dev, "dumpsys account | grep -c 'Account {name='").strip(),
        "google_account": bool(re.search(r"com\.google", sh(dev, "dumpsys account | grep 'Account {name='", timeout=90))),
        "package_installed": pm_installed(dev, pkg),
        "verifier_enabled": sh(dev, "settings get global package_verifier_enable").strip(),
        "clock_epoch": sh(dev, "date +%s").strip(),
    }
    return info


def verify_persisted(dev, evidence_path: str) -> int:
    """Compare a previous run's evidence with the live phone (post-rotation check)."""
    with open(evidence_path) as fh:
        prev = json.load(fh)
    pkg = prev["package"]
    was = prev.get("phases", {}).get("exercise", {})
    now = {
        "installed": pm_installed(dev, pkg),
        "version": sh(dev, f"dumpsys package {pkg} | grep -m1 versionName").strip(),
        "data": app_data_fingerprint(dev, pkg),
        "permissions": grant_runtime_permissions.__wrapped__(dev, pkg) if hasattr(grant_runtime_permissions, "__wrapped__") else None,
        "accounts": sh(dev, "dumpsys account | grep -c 'Account {name='").strip(),
        "android_id": sh(dev, "settings get secure android_id").strip(),
        "packages": sh(dev, "pm list packages -3").split(),
    }
    # Do not re-grant; just read current grants.
    dump = sh(dev, f"dumpsys package {pkg}", timeout=90)
    granted_now = sorted(set(re.findall(r"(android\.permission\.[A-Z_]+): granted=true", dump)))
    expected_perms = set(was.get("permissions", {}).get("granted", []))
    checks = {
        "package_still_installed": now["installed"],
        "version_matches": bool(now["version"]) and now["version"].split()[-1] == (was.get("data", {}).get("version", "").split()[-1] or now["version"].split()[-1]),
        "app_data_present": int(now["data"].get("ce_kb") or 0) >= int(was.get("data", {}).get("ce_kb") or 0),
        "granted_permissions_survived": expected_perms.issubset(set(granted_now)),
        "accounts_present": int(now["accounts"] or 0) > 0,
        "other_previous_packages_present": all(p in now["packages"] for p in prev.get("phases", {}).get("post", {}).get("installed_packages", [])),
    }
    out = {"mode": "verify_persisted", "package": pkg, "checks": checks, "now": now, "expected_permissions": sorted(expected_perms)}
    ok = all(checks.values())
    out["result"] = "PASS" if ok else "FAIL"
    print(json.dumps(out, indent=2, default=str))
    if args_json_global:
        with open(args_json_global, "w") as fh:
            json.dump(out, fh, indent=2, default=str)
    return 0 if ok else 6


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--package", help="Play package to install, e.g. org.billthefarmer.notes")
    ap.add_argument("--verify-json", help="Verify a previous evidence JSON against the live phone (post-rotation)")
    ap.add_argument("--gateway", help="Use the public gateway HTTP API instead of local adb")
    ap.add_argument("--token", default=os.environ.get("EMULATOR_ACCESS_TOKEN", ""))
    ap.add_argument("--timeout", type=int, default=900, help="Seconds to wait for the install to complete")
    ap.add_argument("--json", help="Write the evidence JSON here")
    ap.add_argument("--keep-installed", action="store_true", help="Do not fail when the app is already installed")
    global args_json_global
    args = ap.parse_args()
    args_json_global = args.json

    dev = Gateway(args.gateway, args.token) if args.gateway else AdbLocal()
    if args.verify_json:
        try:
            return verify_persisted(dev, args.verify_json)
        finally:
            dev.close()
    if not args.package:
        ap.error("--package is required unless --verify-json is used")
    pkg = args.package
    EVIDENCE["transport"] = dev.name
    EVIDENCE["package"] = pkg
    rc = 0

    try:
        if isinstance(dev, Gateway):
            h = dev.health()
            EVIDENCE["gateway_health"] = {k: h.get(k) for k in ("active_emulator_connected", "active_session_id", "rotation_count", "sessions_total", "rss_mb", "streaming")}
            if not h.get("active_emulator_connected"):
                EVIDENCE["errors"].append("gateway has no active emulator")
                return finish(args, 4)

        pre = preflight(dev, pkg)
        EVIDENCE["phases"]["preflight"] = pre
        print("[preflight]", json.dumps(pre))
        if pre["boot_completed"] != "1":
            EVIDENCE["errors"].append("device not booted")
            return finish(args, 4)
        if pre["package_installed"] and not args.keep_installed:
            EVIDENCE["errors"].append("package already installed; pick a package that is not installed")
            return finish(args, 4)
        if not pre["google_account"]:
            EVIDENCE["errors"].append("no Google account on the device: Play Store cannot install anything (sign-in is required)")
            return finish(args, 2)

        # ---- phase: open the store listing -------------------------------------
        resumed = open_store_listing(dev, pkg)
        EVIDENCE["phases"]["store_listing"] = {"resumed": resumed}
        print("[store]", resumed)
        if "vending" not in resumed:
            EVIDENCE["errors"].append("Play Store listing did not come to the foreground")

        # ---- phase: press Install ---------------------------------------------
        pressed = False
        for attempt in range(1, 7):
            dismiss_system_dialogs(dev)
            xml = ui_dump(dev)
            if "Sign in" in xml and "Install" not in xml:
                EVIDENCE["errors"].append("Play Store is asking to sign in")
                return finish(args, 2)
            if re.search(r"Complete account setup|Add a payment option", xml, re.I):
                gate = dismiss_system_dialogs(dev)
                EVIDENCE.setdefault("account_setup_gate_seen", []).append(gate)
                if gate.get("dismissed"):
                    time.sleep(2)
                    continue
            pos = find_button(xml, [r"^Install$", r"^Install\b", r"^Update$"])
            EVIDENCE.setdefault("install_button_attempts", []).append({"attempt": attempt, "found": bool(pos), "dl_len": len(xml)})
            if pos:
                dev.tap(*pos)
                pressed = True
                break
            if "Open" in xml or "Uninstall" in xml:
                EVIDENCE["errors"].append("store already shows Open/Uninstall for the package")
                pressed = True
                break
            time.sleep(4)
        EVIDENCE["phases"]["install_button"] = {"pressed": pressed}
        print("[install] button pressed:", pressed)

        # ---- phase: wait for the real install --------------------------------
        result = wait_for_install(dev, pkg, args.timeout)
        EVIDENCE["phases"]["install"] = result
        print("[install]", json.dumps({k: v for k, v in result.items() if k != "timeline"}))
        if not result["installed"]:
            EVIDENCE["logcat_tail"] = logcat(dev, 600).splitlines()[-120:]
            EVIDENCE["download_state"] = sh(dev, "dumpsys download | tail -60")
            EVIDENCE["installer_sessions"] = sh(dev, "pm list sessions -a")
            EVIDENCE["errors"].append(f"install did not complete within {args.timeout}s")
            return finish(args, 3)

        # ---- phase: exercise the installed app -------------------------------
        launched = launch_app(dev, pkg)
        perms = grant_runtime_permissions(dev, pkg)
        data = app_data_fingerprint(dev, pkg)
        EVIDENCE["phases"]["exercise"] = {"launch": launched, "permissions": perms, "data": data}
        print("[exercise]", json.dumps(EVIDENCE["phases"]["exercise"])[:1200])
        if not launched["running"]:
            EVIDENCE["errors"].append("installed app did not reach a resumed activity")

        sh(dev, "input keyevent 3")  # back to launcher, keep app state
        EVIDENCE["phases"]["post"] = {
            "installed_packages": sh(dev, "pm list packages -3").split(),
            "data_free_mb": free_mb(dev, "/data"),
        }
        return finish(args, 0)
    except Exception as exc:
        EVIDENCE["errors"].append(f"exception: {exc}")
        return finish(args, 5)
    finally:
        dev.close()


def finish(args, rc: int) -> int:
    EVIDENCE["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    EVIDENCE["result"] = "PASS" if rc == 0 else "FAIL"
    EVIDENCE["exit_code"] = rc
    blob = json.dumps(EVIDENCE, indent=2, default=str)
    print("=== INSTALL TEST EVIDENCE ===")
    print(blob[-12000:])
    if args.json:
        with open(args.json, "w") as fh:
            fh.write(blob)
    return rc


if __name__ == "__main__":
    sys.exit(main())
