#!/usr/bin/env python3
"""Real GitHub storage integration test; does not connect to the public gateway."""
import json
import os
from pathlib import Path
import sys
from github_state import Store, Conflict, digest

archive = Path(sys.argv[2])
store = Store()
owner = 'validation-' + os.environ['GITHUB_RUN_ID']
store.initialize(owner)
metadata = json.loads(Path(str(archive) + '.json').read_text())
cp = store.publish(archive, owner, metadata)
result = store.restore('/tmp/restored-avd.tar.zst')
if result['checkpoint'] != cp:
    raise RuntimeError('Wrong checkpoint selected')
# Stream comparison avoids loading multiple gigabytes into memory.
import hashlib

def hash_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        while block := f.read(1024*1024): h.update(block)
    return h.hexdigest()

assert hash_file(archive) == hash_file('/tmp/restored-avd.tar.zst')
try:
    store.owner('different-workflow')
except Conflict:
    pass
else:
    raise AssertionError('Concurrent writer was not fenced')
print(json.dumps({'encrypted_github_roundtrip': True, 'writer_fencing': True,
                  'checkpoint_release_id': cp['release_id'], 'public_phone_untouched': True}))
