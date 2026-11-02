#!/usr/bin/env python3
"""Capture the entire AVD only while its virtual CPU is stopped.
No running-disk copy, root requirement, APK reinstall, or Android permission rewriting.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time


def run(*args, timeout=120):
    return subprocess.run(args, check=True, capture_output=True, timeout=timeout).stdout


def adb(command):
    return run('adb', 'shell', command).decode(errors='replace').strip()


def console(*args):
    out = run('adb', 'emu', *args).decode(errors='replace')
    if 'KO:' in out or not re.search(r'\bOK\b', out):
        raise RuntimeError('Emulator rejected console operation: ' + ' '.join(args[:2]))
    return out


def hashed(s):
    return hashlib.sha256(s.encode()).hexdigest()


def guest_evidence():
    # Only hashes are persisted for account identifiers. Never log dumpsys account.
    accounts = adb("dumpsys account | grep 'Account {name=' | sort")
    packages = adb('pm list packages -f | sort')
    permissions = adb('dumpsys package | sed -n "/runtime permissions:/,/Queries:/p"')
    foreground = adb("dumpsys activity activities | grep ResumedActivity")
    component = re.search(r' u\d+ ([^ /]+/[^ ]+)', foreground)
    return {'account_hash': hashed(accounts), 'account_count': accounts.count('Account {name='),
            'packages_hash': hashed(packages), 'permissions_hash': hashed(permissions),
            'tiktok_installed': bool(adb('pm path com.zhiliaoapp.musically 2>/dev/null || true')),
            'foreground': component.group(1) if component else None,
            'android_id_hash': hashed(adb('settings get secure android_id')),
            'settings_hash': hashed('\n'.join(adb('settings list ' + x) for x in ('system', 'secure'))),
            'build_fingerprint': adb('getprop ro.build.fingerprint'),
            'boot': adb('getprop sys.boot_completed') == '1'}


def sdk_evidence():
    sdk = Path(os.environ.get('ANDROID_SDK_ROOT') or os.environ['ANDROID_HOME'])
    files = [sdk/'emulator/source.properties']
    files += list((sdk/'system-images/android-34/google_apis_playstore/x86_64').glob('source.properties'))
    if len(files) != 2:
        raise RuntimeError('Expected official API34 Google Play image not found')
    return {str(p.relative_to(sdk)): hashed(p.read_text()) for p in files}


def capture(avd, destination, hold=False):
    avd = Path(avd).resolve(); destination = Path(destination).resolve()
    if not (avd/'config.ini').is_file():
        raise ValueError('AVD config missing')
    if not list(avd.glob('userdata*')):
        raise ValueError('Refusing snapshot without actual userdata disks')
    if destination.is_relative_to(avd):
        raise ValueError('Archive must not be stored inside its own source AVD')
    evidence = {'schema': 1, 'guest': guest_evidence(), 'sdk': sdk_evidence(),
                'avd_name': avd.name.removesuffix('.avd'), 'snapshot': 'vibely-checkpoint', 'created_at': int(time.time())}
    if not evidence['guest']['boot']:
        raise RuntimeError('Unbooted Android is not a valid checkpoint')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='vibely-avd-') as tmp:
        os.chmod(tmp, 0o700)
        stage = Path(tmp)/'avd'
        stopped = False
        try:
            adb('sync')
            console('avd', 'stop'); stopped = True
            if 'stopped' not in console('avd', 'status').lower():
                raise RuntimeError('VM pause not confirmed; refusing live disk copy')
            console('avd', 'snapshot', 'save', 'vibely-checkpoint')
            if 'stopped' not in console('avd', 'status').lower():
                raise RuntimeError('Snapshot unexpectedly resumed VM; refusing disk copy')
            run('sync')
            # Full AVD: userdata, metadata/encryption/keystore disks, SD card,
            # hardware config, qcow2 overlays and RAM snapshot all travel together.
            run('cp', '-a', '--reflink=auto', str(avd), str(stage), timeout=600)
            for p in stage.rglob('*'):
                if p.name.endswith('.lock'):
                    if p.is_dir(): shutil.rmtree(p)
                    else: p.unlink()
            if not (stage/'snapshots/vibely-checkpoint').is_dir():
                raise RuntimeError('Saved RAM snapshot missing')
        finally:
            if stopped and not hold:
                console('avd', 'start')
        Path(tmp, 'manifest.json').write_text(json.dumps(evidence, sort_keys=True))
        partial = destination.with_suffix(destination.suffix + '.partial')
        try:
            run('tar', '--sparse', '--zstd', '-cf', str(partial), '-C', tmp, 'avd', 'manifest.json', timeout=900)
            os.chmod(partial, 0o600)
            # Validate the entire compressed stream, not merely archive headers.
            run('zstd', '-t', str(partial), timeout=600)
            os.replace(partial, destination)
        except BaseException:
            partial.unlink(missing_ok=True)
            # A failed final handover must leave the source serving, not paused.
            if stopped and hold:
                console('avd', 'start')
            raise
    return evidence


def extract(archive, avd):
    avd = Path(avd).resolve()
    # Restore must occur before the emulator opens this directory.
    if (avd/'hardware-qemu.ini.lock').exists() or (avd/'multiinstance.lock').exists():
        raise RuntimeError('Destination emulator may be running; restore refused')
    with tempfile.TemporaryDirectory(prefix='vibely-restore-', dir=avd.parent) as tmp:
        os.chmod(tmp, 0o700)
        # GNU tar zstd stream -> stdlib path/symlink validation before extraction.
        proc = subprocess.Popen(['zstd', '-dc', str(archive)], stdout=subprocess.PIPE)
        try:
            with tarfile.open(fileobj=proc.stdout, mode='r|') as tar:
                tar.extractall(tmp, filter='data')
            if proc.wait() != 0:
                raise ValueError('Compressed checkpoint is corrupt')
        finally:
            proc.stdout.close()
            if proc.poll() is None: proc.kill(); proc.wait()
        manifest = json.loads(Path(tmp, 'manifest.json').read_text())
        if manifest['sdk'] != sdk_evidence():
            raise RuntimeError('System-image/emulator version changed; explicit migration required')
        restored = Path(tmp, 'avd')
        if not (restored/'snapshots/vibely-checkpoint').is_dir() or not list(restored.glob('userdata*')):
            raise ValueError('Checkpoint is not a complete AVD')
        # Never overwrite a preexisting phone implicitly, even on a failed restore.
        if avd.exists():
            raise RuntimeError('Destination already exists; explicit isolated destination required')
        os.replace(restored, avd)
        ini = avd.with_suffix('.ini')
        ini.write_text('avd.ini.encoding=UTF-8\npath=' + str(avd) + '\ntarget=android-34\n')
        return manifest


def verify(expected):
    current = guest_evidence(); wanted = expected['guest']
    raw = run('adb', 'exec-out', 'screencap', '-p', timeout=40)
    # A black image is NOT treated as success merely because it is a PNG.
    from PIL import Image, ImageStat
    import io
    image = Image.open(io.BytesIO(raw)).convert('RGB')
    stat = ImageStat.Stat(image)
    return {'boot': current['boot'], 'display': max(stat.mean) > 2 and max(stat.stddev) > 1,
            'packages': current['packages_hash'] == wanted['packages_hash'],
            'account_hash': current['account_hash'] == wanted['account_hash'],
            'settings': current['settings_hash'] == wanted['settings_hash'],
            'userdata': current['android_id_hash'] == wanted['android_id_hash'] and current['permissions_hash'] == wanted['permissions_hash'],
            'foreground': current['foreground'] == wanted['foreground'],
            'tiktok_installed': current['tiktok_installed']}


def main():
    p = argparse.ArgumentParser(); p.add_argument('action', choices=['capture', 'extract', 'verify'])
    p.add_argument('--avd'); p.add_argument('--archive'); p.add_argument('--manifest'); p.add_argument('--hold', action='store_true')
    a = p.parse_args()
    if a.action == 'capture':
        result = capture(a.avd, a.archive, a.hold)
        Path(a.archive + '.json').write_text(json.dumps(result)); os.chmod(a.archive + '.json', 0o600)
        print(json.dumps({'captured': True, 'format': 'whole-avd-v1', 'source_held': a.hold}))
    elif a.action == 'extract':
        result = extract(a.archive, a.avd)
        Path(a.archive + '.restored.json').write_text(json.dumps(result)); os.chmod(a.archive + '.restored.json', 0o600)
        print(json.dumps({'extracted': True}))
    else:
        result = verify(json.loads(Path(a.manifest).read_text())); print(json.dumps(result))
        if not all(result[k] for k in ('boot', 'display', 'packages', 'account_hash', 'settings', 'userdata', 'foreground')):
            raise SystemExit(1)


if __name__ == '__main__':
    main()
