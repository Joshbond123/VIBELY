#!/usr/bin/env python3
"""Wait for a *new* whole-AVD checkpoint to be published, then report it.

The phone only survives a rotation if the change was captured: the agent writes a
new ~8.4 GB checkpoint after a change settles (90 s debounce, and never while a
Play download/install is busy). A cancelled run, a crash, or a guest that stayed
busy means no capture, and the next boot restores the previous generation.

Usage:  verify-persist.py --since 46 [--timeout 1200]
Exit 0 only if the generation advanced and the new release carries a fresh,
complete payload (manifest + parts).
"""
from __future__ import annotations
import argparse, base64, json, os, sys, time, urllib.request

REPO = os.environ.get("GITHUB_REPOSITORY", "Joshbond123/VIBELY")
BRANCH = os.environ.get("ANDROID_STATE_BRANCH", "android-state-v1")
PAT = os.environ.get("GH_PAT") or os.environ.get("GITHUB_TOKEN") or ""


def api(path: str):
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}{path}",
                                 headers={"Authorization": f"Bearer {PAT}",
                                          "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def state() -> dict:
    d = api(f"/contents/state.json?ref={BRANCH}")
    return json.loads(base64.b64decode(d["content"]).decode())


def release(tag: str) -> dict:
    return api(f"/releases/tags/{tag}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=None, help="generation to beat (default: current)")
    ap.add_argument("--timeout", type=int, default=1200)
    args = ap.parse_args()

    cur = state()
    since = args.since if args.since is not None else cur["generation"]
    print(f"[verify-persist] baseline generation={since} current={cur['generation']}")
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        cur = state()
        if cur["generation"] > since:
            break
        print(f"[verify-persist] waiting… generation still {cur['generation']}")
        time.sleep(60)
    else:
        print(f"[verify-persist] FAIL: no new checkpoint within {args.timeout}s — "
              f"this session's changes are NOT saved and will be lost on the next rotation.")
        return 1

    tag = cur["current"]["tag"]
    rel = release(tag)
    assets = rel.get("assets", [])
    total = sum(a["size"] for a in assets)
    newest = max((a["updated_at"] for a in assets), default="")
    parts = [a for a in assets if a["name"].startswith("part-")]
    has_manifest = any(a["name"] == "manifest.gcm" for a in assets)
    ok = has_manifest and len(parts) > 0 and total > 1_000_000_000
    print(f"[verify-persist] {'PASS' if ok else 'FAIL '} generation={cur['generation']} tag={tag} "
          f"parts={len(parts)} total={total/1e9:.2f} GB newest_upload={newest}")
    if not ok:
        print("[verify-persist] FAIL: checkpoint exists but its payload looks incomplete; "
              "the restore would fall back or come back short.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
