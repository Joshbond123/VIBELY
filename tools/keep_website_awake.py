#!/usr/bin/env python3
"""Website-only counterpart of the emulator's health/resume keep-awake pattern.

Uses the existing public Blitz resume API, never GPU dispatch or emulator APIs.
Scheduled GitHub Actions are best-effort, not an always-on hosting guarantee.
"""
import json
import os
import sys
import time
import urllib.request

WEBSITE_APP = "66184937-3da8-4df4-88af-eb475f889a43"


def parse_rpc(text):
    try:
        return json.loads(text)
    except ValueError:
        return json.loads("\n".join(line[5:].strip() for line in text.splitlines() if line.startswith("data:")))


def resume_website(key, app):
    if app != WEBSITE_APP:
        raise ValueError("Refusing to resume any app other than the VIBELY website")
    endpoint = os.environ.get("BLITZ_MCP_ENDPOINT", "https://mcp.blitz.cloud/mcp")
    headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json",
               "Accept": "application/json, text/event-stream"}

    def rpc(method, params, number):
        request = urllib.request.Request(endpoint, data=json.dumps({"jsonrpc": "2.0", "id": number,
            "method": method, "params": params}).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=40) as response:
            session = response.headers.get("mcp-session-id")
            if session:
                headers["Mcp-Session-Id"] = session
            result = parse_rpc(response.read().decode())
        if result.get("error") or result.get("result", {}).get("isError"):
            raise RuntimeError("Website resume operation was rejected")
        return result

    rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
        "clientInfo": {"name": "vibely-website-keep-awake", "version": "1"}}, 1)
    # Idempotent resume also refreshes the control-plane request when already awake.
    # This targets the website only; it does not restart or inspect the phone.
    rpc("tools/call", {"name": "apps_resume", "arguments": {"app": app}}, 2)


def main():
    key = os.environ.get("BLITZ_API_KEY", "")
    app = os.environ.get("BLITZ_WEBSITE_APP", "")
    if not key or app != WEBSITE_APP:
        print("Website keep-awake requires its own valid, website-scoped settings.")
        return 1
    try:
        resume_website(key, app)
        print("Website-only resume request accepted.")
    except Exception as error:
        print("Website resume check:", type(error).__name__)
    primary = os.environ.get("WEBSITE_PRIMARY", "https://aivideo.aivideo.prod.page")
    fallback = os.environ.get("WEBSITE_FALLBACK", "https://aivideo.aivideo.blitz.cloud")
    for attempt in range(6):
        for host in (primary, fallback):
            try:
                request = urllib.request.Request(host.rstrip("/") + "/api/health",
                    headers={"User-Agent": "VIBELY-Website-KeepAwake/1"})
                with urllib.request.urlopen(request, timeout=25) as response:
                    health = json.load(response)
                if not health.get("ok") or not health.get("database", {}).get("connected"):
                    continue
                count = health.get("character_references", {}).get("count", "unknown")
                print("Website healthy; database connected; stored character references:", count)
                summary = os.environ.get("GITHUB_STEP_SUMMARY")
                if summary:
                    with open(summary, "a") as output:
                        output.write("### Website keep-awake\n- Website healthy: yes\n- Database connected: yes\n"
                                     "- Emulator unchanged\n- No generation or GPU activation requested\n"
                                     "- Schedule: every 10 minutes (GitHub scheduling is best-effort)\n")
                return 0
            except Exception:
                pass
        if attempt < 5:
            time.sleep(10)
    print("Website did not become healthy within the bounded keep-awake check.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
