#!/usr/bin/env python3
"""Ask Blitz to resume the Android container (keeps the reverse tunnel warm).

Extracted from the keep-awake workflow: the inline heredoc in that workflow broke
the YAML block scalar, so the scheduled job failed to parse and never ran.
"""
import json
import os
import sys
import urllib.request

KEY = os.environ.get("BLITZ_API_KEY", "")
APP = os.environ.get("BLITZ_ANDROID_APP", "")
ENDPOINT = os.environ.get("BLITZ_MCP_ENDPOINT", "https://mcp.blitz.cloud/mcp")


def call(method, params, rid, headers):
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode(),
        headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.headers.get("mcp-session-id"), r.read().decode()


def main():
    if not (KEY and APP):
        print("blitz-resume: BLITZ_API_KEY/BLITZ_ANDROID_APP not set; nothing to resume.")
        return 0
    headers = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
               "Accept": "application/json, text/event-stream"}
    try:
        sid, out = call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                       "clientInfo": {"name": "keep-awake", "version": "1"}}, 1, headers)
        if sid:
            headers["Mcp-Session-Id"] = sid
        sid, out = call("tools/call", {"name": "apps_resume", "arguments": {"app": APP}}, 2, headers)
        print("blitz-resume:", out[:400])
    except Exception as e:  # never fail the keep-alive job on a resume hiccup
        print("blitz-resume warning:", str(e)[:300])
    return 0


if __name__ == "__main__":
    sys.exit(main())
