#!/usr/bin/env python3
"""Actual whole-AVD/RAM checkpoint on the Actions host, never a Blitz tar backup."""
import json,os
from pathlib import Path
from avd_checkpoint import capture
from github_state import Store
s=Store();owner=os.environ['EMULATOR_SESSION_ID'];s.owner(owner)
p=Path('/tmp/live-verified-avd.tar.zst')
try:
 metadata=capture(os.environ['AVD_DIR'],p)
 cp=s.publish(p,owner,metadata)
 print(json.dumps({'event':'FULL_AVD_GITHUB_CHECKPOINT_PUBLISHED','release_id':cp['release_id']}),flush=True)
finally:
 p.unlink(missing_ok=True);Path(str(p)+'.json').unlink(missing_ok=True)
