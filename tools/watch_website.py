#!/usr/bin/env python3
"""Bounded external website availability watch with an explicit Actions handoff.

The host may ignore self-originated traffic. Run outside that host, request the
real document, and invoke website-only resume only when health is unavailable.
No model dispatch, emulator operations, or billing/hosting-plan changes are made.
Disable the website workflow or set WEBSITE_KEEP_AWAKE_ENABLED=false to stop.
"""
import json
import os
import time
import urllib.request
from keep_website_awake import main as check_website


def main():
    minutes = min(50, max(1, int(os.environ.get('WATCH_MINUTES', '50'))))
    end = time.monotonic() + minutes * 60
    failures = 0
    while time.monotonic() < end:
        started = time.monotonic()
        try:
            if check_website() != 0:
                failures += 1
                print('::warning::Website health not confirmed; retrying in this bounded watch.', flush=True)
        except Exception as error:
            failures += 1
            print('::warning::Website watch check failed:', type(error).__name__, flush=True)
        remaining = end - time.monotonic()
        if remaining > 0:
            time.sleep(min(remaining, max(1, 60 - (time.monotonic() - started))))
    token = os.environ.get('GITHUB_TOKEN', '')
    repo = os.environ.get('GITHUB_REPOSITORY', '')
    handed_off = False
    if token and repo == 'Joshbond123/VIBELY':
        request = urllib.request.Request(
            'https://api.github.com/repos/' + repo + '/actions/workflows/keep-website-awake.yml/dispatches',
            data=json.dumps({'ref': 'main'}).encode(), method='POST',
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                     'Content-Type': 'application/json', 'User-Agent': 'VIBELY-Website-Availability-Watch'})
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                handed_off = response.status == 204
        except Exception as error:
            print('::warning::Website watch handoff unavailable:', type(error).__name__, flush=True)
    print('Bounded external website watch ended; failed checks:', failures,
          '; next website watch dispatched:', handed_off, flush=True)
    # No hosting uptime guarantee: a runner or scheduling outage can still cause gaps.


if __name__ == '__main__':
    main()
