#!/usr/bin/env python3
"""Publish a verified whole-AVD checkpoint to GitHub (branch + Release assets).

Claims write ownership first so rotated workflows are not permanently fenced
out of persistence (root cause of lost login/apps after rotation).
"""
import json
import os
import sys
from pathlib import Path

# Allow running as `python3 android-emulator/github_live_checkpoint.py`
sys.path.insert(0, str(Path(__file__).resolve().parent))

from avd_checkpoint import capture  # noqa: E402
from github_state import Store  # noqa: E402


def main():
    owner = os.environ.get('EMULATOR_SESSION_ID') or os.environ.get('GITHUB_RUN_ID') or 'local'
    avd = os.environ.get('AVD_DIR') or str(Path.home() / '.android/avd/vibely_pixel6_api34.avd')
    hold = os.environ.get('CHECKPOINT_HOLD', 'false').lower() == 'true'
    store = Store()
    # Permanent fix: claim ownership so publish is not fenced after rotation.
    claim = store.claim_owner(owner)
    print(json.dumps({'event': 'OWNER_CLAIMED', 'owner': claim[1].get('owner'), 'generation': claim[1].get('generation')}), flush=True)

    dest = Path('/tmp/live-verified-avd.tar.zst')
    try:
        metadata = capture(avd, dest, hold=hold)
        metadata = dict(metadata)
        metadata.setdefault('source_run', os.environ.get('GITHUB_RUN_ID', ''))
        metadata.setdefault('format', 'whole-avd-v1')
        metadata['source_held'] = bool(hold)
        cp = store.publish(dest, owner, metadata)
        print(json.dumps({
            'event': 'FULL_AVD_GITHUB_CHECKPOINT_PUBLISHED',
            'release_id': cp.get('release_id'),
            'tag': cp.get('tag'),
            'generation_bump': True,
            'hold': hold,
        }), flush=True)
    finally:
        dest.unlink(missing_ok=True)
        Path(str(dest) + '.json').unlink(missing_ok=True)


if __name__ == '__main__':
    main()
