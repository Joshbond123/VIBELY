#!/usr/bin/env python3
"""GitHub-native whole-AVD storage. Never logs snapshot contents or credentials.
Release assets are immutable ciphertext; a small Git ref is the CAS commit point.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import tempfile
import time
import uuid

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b'VIBELY-AVD-1\0'
BRANCH = os.environ.get('ANDROID_STATE_BRANCH', 'android-state-v1')
AAD = b'vibely-whole-avd-v1'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encrypt(data, password):
    salt, nonce = secrets.token_bytes(16), secrets.token_bytes(12)
    key = Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(password.encode())
    return MAGIC + salt + nonce + AESGCM(key).encrypt(nonce, data, AAD)


def decrypt(data, password):
    if not data.startswith(MAGIC):
        raise ValueError('Unknown encrypted snapshot format')
    i = len(MAGIC)
    salt, nonce = data[i:i+16], data[i+16:i+28]
    key = Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(password.encode())
    return AESGCM(key).decrypt(nonce, data[i+28:], AAD)


class Conflict(RuntimeError):
    pass


class Store:
    def __init__(self, repo=None, token=None, password=None):
        self.repo = repo or os.environ['GITHUB_REPOSITORY']
        self.password = password or os.environ['EMULATOR_STATE_KEY']
        if len(self.password) < 32:
            raise ValueError('EMULATOR_STATE_KEY must contain at least 32 random characters')
        self.http = requests.Session()
        self.http.headers.update({'Authorization': 'Bearer ' + (token or os.environ['GH_PAT']),
                                  'Accept': 'application/vnd.github+json',
                                  'X-GitHub-Api-Version': '2022-11-28'})
        self.base = 'https://api.github.com/repos/' + self.repo

    def api(self, method, path, **kw):
        # Mutating operations are NOT blindly retried after ambiguous responses.
        for attempt in range(4):
            r = self.http.request(method, self.base + path, timeout=(20, 180), **kw)
            if r.status_code in (409, 422):
                raise Conflict('GitHub state conflict; original owner/checkpoint preserved')
            if method == 'GET' and r.status_code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(min(15, 2**attempt)); continue
            r.raise_for_status()
            return r.json() if r.content else None

    def read(self):
        ref = self.api('GET', '/git/ref/heads/' + BRANCH)
        sha = ref['object']['sha']
        commit = self.api('GET', '/git/commits/' + sha)
        tree = self.api('GET', '/git/trees/' + commit['tree']['sha'])
        blob = next(x for x in tree['tree'] if x['path'] == 'state.json')
        raw = self.api('GET', '/git/blobs/' + blob['sha'])
        state = json.loads(base64.b64decode(raw['content']))
        return sha, state

    def cas(self, old_sha, state):
        blob = self.api('POST', '/git/blobs', json={'content': json.dumps(state, sort_keys=True), 'encoding': 'utf-8'})
        tree = self.api('POST', '/git/trees', json={'tree': [{'path': 'state.json', 'mode': '100644', 'type': 'blob', 'sha': blob['sha']}]})
        commit = self.api('POST', '/git/commits', json={'message': 'Atomic encrypted Android state generation ' + str(state['generation']), 'tree': tree['sha'], 'parents': [old_sha] if old_sha else []})
        if old_sha:
            self.api('PATCH', '/git/refs/heads/' + BRANCH, json={'sha': commit['sha'], 'force': False})
        else:
            self.api('POST', '/git/refs', json={'ref': 'refs/heads/' + BRANCH, 'sha': commit['sha']})
        return commit['sha']

    def initialize(self, owner):
        try:
            return self.read()
        except requests.HTTPError as e:
            if e.response.status_code != 404:
                raise
        state = {'schema': 1, 'generation': 0, 'owner': owner, 'current': None, 'previous': None, 'pending': None}
        self.cas(None, state)
        return self.read()

    def owner(self, expected):
        try:
            sha, state = self.read()
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 404:
                self.initialize(expected)
                sha, state = self.read()
            else:
                raise
        if state['owner'] != expected:
            raise Conflict('Writer is fenced: this workflow does not own the Android phone')
        return sha, state

    def claim_owner(self, expected):
        """Become the sole write-owner of the GitHub-backed phone state.
        Required after workflow rotation: previous SESSION_ID is gone, so
        fencing would otherwise block every checkpoint publish forever.
        """
        try:
            sha, state = self.read()
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 404:
                return self.initialize(expected)
            raise
        if state.get('owner') == expected:
            return sha, state
        # Refuse to steal ownership only during an in-flight held handover.
        pending = state.get('pending') or {}
        if pending.get('source_held') and pending.get('source') and pending.get('source') != expected:
            # Allow the designated candidate to claim.
            if pending.get('candidate') != expected:
                raise Conflict('Handover in progress; cannot claim owner')
        state['owner'] = expected
        state['pending'] = None
        self.cas(sha, state)
        return self.read()

    def upload_asset(self, release, name, content):
        url = release['upload_url'].split('{')[0]
        r = self.http.post(url, params={'name': name}, data=content,
                           headers={'Content-Type': 'application/octet-stream'}, timeout=(20, 600))
        r.raise_for_status()
        asset = r.json()
        if asset['size'] != len(content) or (asset.get('digest') and asset['digest'] != 'sha256:' + digest(content)):
            raise ValueError('GitHub asset integrity mismatch')
        return {'id': asset['id'], 'name': name, 'sha256': digest(content), 'bytes': len(content)}

    def download_asset(self, asset):
        # Only authenticated GitHub release endpoints; requests removes Authorization on cross-host redirects.
        r = self.http.get(self.base + '/releases/assets/' + str(asset['id']),
                          headers={'Accept': 'application/octet-stream'}, timeout=(20, 600))
        r.raise_for_status()
        if len(r.content) != asset['bytes'] or digest(r.content) != asset['sha256']:
            raise ValueError('Encrypted asset checksum mismatch')
        return r.content

    def publish(self, archive, owner, metadata, part_bytes=256*1024*1024):
        try:
            head, state = self.owner(owner)
        except Conflict:
            # Permanent fix: rotated workflow must claim write ownership or
            # checkpoints never become current and login/apps vanish forever.
            head, state = self.claim_owner(owner)
            head, state = self.owner(owner)
        tag = 'android-checkpoint-' + str(state['generation'] + 1) + '-' + uuid.uuid4().hex
        release = self.api('POST', '/releases', json={'tag_name': tag, 'target_commitish': 'main', 'name': tag,
                           'body': 'AES-256-GCM authenticated whole-AVD checkpoint. No plaintext Android data.',
                           'draft': True, 'prerelease': True})
        parts, total, archive_hash = [], 0, hashlib.sha256()
        with open(archive, 'rb') as src:
            while True:
                block = src.read(part_bytes)
                if not block:
                    break
                archive_hash.update(block); total += len(block)
                parts.append(self.upload_asset(release, f'part-{len(parts):05d}.gcm', encrypt(block, self.password)))
        if not parts:
            raise ValueError('Empty checkpoint refused')
        manifest = {'schema': 1, 'parts': parts, 'archive_sha256': archive_hash.hexdigest(),
                    'archive_bytes': total, 'metadata': metadata, 'source_owner': owner}
        ma = self.upload_asset(release, 'manifest.gcm', encrypt(json.dumps(manifest).encode(), self.password))
        # Read back and authenticate the commit manifest before making it discoverable.
        if json.loads(decrypt(self.download_asset(ma), self.password)) != manifest:
            raise ValueError('Manifest verification failed')
        self.api('PATCH', '/releases/' + str(release['id']), json={'draft': False})
        checkpoint = {'release_id': release['id'], 'tag': tag, 'manifest': ma,
                      'format': 'whole-avd-v1', 'created_at': int(time.time())}
        # No rebase/retry: a changed head or owner fences this writer.
        current_head, _ = self.owner(owner)
        if current_head != head:
            raise Conflict('Ownership/state changed during upload; uploaded release left unreferenced')
        state.update(generation=state['generation']+1, previous=state['current'], current=checkpoint)
        self.cas(head, state)
        return checkpoint

    def restore_checkpoint(self, checkpoint, destination):
        manifest = json.loads(decrypt(self.download_asset(checkpoint['manifest']), self.password))
        dest = Path(destination)
        dest.parent.mkdir(parents=True, exist_ok=True)
        temp = dest.with_name(dest.name + '.partial-' + uuid.uuid4().hex)
        h, total = hashlib.sha256(), 0
        try:
            with open(temp, 'xb') as out:
                os.chmod(temp, 0o600)
                for part in manifest['parts']:
                    plain = decrypt(self.download_asset(part), self.password)
                    h.update(plain); total += len(plain); out.write(plain)
                out.flush(); os.fsync(out.fileno())
            if total != manifest['archive_bytes'] or h.hexdigest() != manifest['archive_sha256']:
                raise ValueError('Full archive verification failed')
            os.replace(temp, dest)
            return manifest
        finally:
            temp.unlink(missing_ok=True)

    def restore(self, destination):
        _, state = self.read()
        errors = []
        for name in ('current', 'previous'):
            cp = state.get(name)
            if not cp:
                continue
            try:
                manifest = self.restore_checkpoint(cp, destination)
                return {'checkpoint': cp, 'manifest': manifest, 'fallback_used': name == 'previous'}
            except Exception as e:
                errors.append(type(e).__name__)
        raise RuntimeError('No verified checkpoint available; clean boot forbidden. Failures: ' + ','.join(errors))

    def prepare(self, owner, candidate, source_held=False):
        head, state = self.owner(owner)
        if state.get('pending') and state['pending']['candidate'] != candidate:
            raise Conflict('Another handover already owns the candidate lock')
        if not state.get('current'):
            raise ValueError('Cannot hand over without a verified whole-AVD checkpoint')
        if source_held:
            manifest = json.loads(decrypt(self.download_asset(state['current']['manifest']), self.password))
            if manifest['metadata'].get('source_held') is not True or manifest['source_owner'] != owner:
                raise ValueError('Final promotion requires a checkpoint captured with the source held')
        state['pending'] = {'source_held': bool(source_held), 'candidate': candidate, 'source': owner, 'checkpoint': state['current'],
                            'prepared_generation': state['generation']}
        self.cas(head, state)

    def promote(self, candidate, checkpoint, verification):
        required = ('boot', 'display', 'packages', 'account_hash', 'settings', 'userdata', 'foreground')
        if not all(verification.get(k) is True for k in required):
            raise ValueError('Candidate verification incomplete; active owner preserved')
        head, state = self.read()
        pending = state.get('pending') or {}
        if pending.get('candidate') != candidate or pending.get('checkpoint') != checkpoint or state['current'] != checkpoint:
            raise Conflict('Stale/unprepared candidate cannot become the active writer')
        if pending.get('source_held') is not True:
            raise ValueError('A prewarmed candidate cannot replace a source that is still accepting writes')
        state.update(owner=candidate, pending=None, generation=state['generation']+1)
        self.cas(head, state)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['init', 'status', 'publish', 'restore', 'claim'])
    p.add_argument('--owner', default=os.environ.get('EMULATOR_SESSION_ID') or os.environ.get('GITHUB_RUN_ID', ''))
    p.add_argument('--archive'); p.add_argument('--metadata')
    a = p.parse_args(); store = Store()
    if a.action == 'init':
        store.initialize(a.owner)
    elif a.action == 'claim':
        sha, s = store.claim_owner(a.owner)
        print(json.dumps({'claimed': True, 'owner': s.get('owner'), 'generation': s.get('generation'), 'has_current': bool(s.get('current'))}))
    elif a.action == 'status':
        try:
            _, s = store.read()
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 404:
                store.initialize(a.owner); _, s = store.read()
            else:
                raise
        print(json.dumps(s))
    elif a.action == 'publish':
        m = json.loads(a.metadata) if a.metadata and a.metadata.strip().startswith('{') else json.loads(Path(a.metadata).read_text())
        print(json.dumps(store.publish(a.archive, a.owner, m)))
    else:
        result = store.restore(a.archive)
        Path(a.archive + '.manifest.json').write_text(json.dumps(result))
        os.chmod(a.archive + '.manifest.json', 0o600)
        print(json.dumps({'restored': True, 'fallback_used': result['fallback_used']}))


if __name__ == '__main__':
    main()
