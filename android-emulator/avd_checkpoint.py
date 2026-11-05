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


class ResumeFailed(RuntimeError):
    """The guest did not come back after the checkpoint paused its vCPU."""
    exit_code = 42


def run(*args, timeout=120):
    try:
        return subprocess.run(args, check=True, capture_output=True, timeout=timeout).stdout
    except subprocess.CalledProcessError as e:
        if args[0] in ('tar', 'zstd', 'cp', 'rsync'):
            raise RuntimeError('Host checkpoint operation failed: ' + e.stderr.decode(errors='replace')[-1800:]) from None
        raise


def adb(command):
    return run('adb', 'shell', command).decode(errors='replace').strip()


def console(*args):
    out = run('adb', 'emu', *args).decode(errors='replace')
    if 'KO:' in out or not re.search(r'\bOK\b', out):
        raise RuntimeError('Emulator rejected console operation: ' + ' '.join(args[:2]))
    return out


def guest_responding(timeout=90):
    """Poll adb until the guest answers again (resume verification)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if adb('getprop sys.boot_completed').startswith('1'):
                return True
        except Exception:
            pass
        time.sleep(3)
    return False


def hashed(s):
    return hashlib.sha256(s.encode()).hexdigest()


def canonical_permissions(dump):
    # Discard dumpsys timestamps, heap object addresses, unrelated resolver tables
    # and package-manager statistics. Preserve the actual grant + Android flags.
    package, user, runtime = None, None, False
    grants = {}
    for line in dump.splitlines():
        p = re.match(r'\s*Package \[([^\]]+)\]', line)
        if p:
            package, user, runtime = p.group(1), None, False
        u = re.match(r'\s*User (\d+):', line)
        if u:
            user, runtime = u.group(1), False
        if line.strip() == 'runtime permissions:':
            runtime = True
        g = re.match(r'\s*([\w.]+): granted=(true|false), flags=\[([^\]]*)\]', line)
        if runtime and package and user is not None and g:
            flags = sorted(x.strip() for x in g.group(3).split('|') if x.strip())
            grants[package + ':' + user + ':' + g.group(1)] = [g.group(2), flags]
    return json.dumps(grants, sort_keys=True)


def guest_evidence():
    # Only hashes are persisted for account identifiers. Never log dumpsys account.
    # dumpsys also contains timestamped account history and transient object IDs.
    # Compare actual account records, not the diagnostic history containing them.
    account_dump = adb('dumpsys account')
    accounts = '\n'.join(sorted(re.findall(r'^\s*Account \{name=([^}]+)\}\s*$', account_dump, re.M)))
    counts = re.findall(r'^\s*Accounts:\s*(\d+)\s*$', account_dump, re.M)
    if not counts or sum(map(int, counts)) != len(accounts.splitlines()):
        raise RuntimeError('Account inventory could not be parsed completely; verification refused')
    packages = adb('pm list packages -f | sort')
    permission_dump = adb('dumpsys package')
    permissions = canonical_permissions(permission_dump)
    foreground = adb("dumpsys activity activities | grep ResumedActivity")
    component = re.search(r' u\d+ ([^ /]+/[^ ]+)', foreground)
    return {'account_hash': hashed(accounts), 'account_count': len(accounts.splitlines()),
            'packages_hash': hashed(packages), 'permissions_hash': hashed(permissions),
            'tiktok_installed': bool(adb('pm path com.zhiliaoapp.musically 2>/dev/null || true')),
            'foreground': component.group(1) if component else None,
            'android_id_hash': hashed(adb('settings get secure android_id')),
            'settings_hash': hashed('\n'.join('\n'.join(sorted(adb('settings list ' + x).splitlines())) for x in ('system', 'secure'))),
            'build_fingerprint': adb('getprop ro.build.fingerprint'),
            'boot': adb('getprop sys.boot_completed') == '1'}


def sdk_evidence():
    sdk = Path(os.environ.get('ANDROID_SDK_ROOT') or os.environ.get('ANDROID_HOME') or '/usr/local/lib/android/sdk')
    family=os.environ.get('ANDROID_CHECKPOINT_IMAGE_FAMILY','google_apis_playstore')
    if family not in ('google_apis_playstore','google_apis'):
        raise RuntimeError('Unsupported checkpoint image family')
    evidence = {'family': family, 'api': '34', 'arch': 'x86_64'}
    candidates = [sdk/'emulator/source.properties']
    try:
        candidates += list((sdk/('system-images/android-34/'+family+'/x86_64')).glob('source.properties'))
    except OSError:
        pass
    found = 0
    for p in candidates:
        # Restore runs before the emulator package is installed by the workflow,
        # so a missing source.properties is normal and must never abort a restore.
        try:
            if not p.is_file():
                continue
            found += 1
            evidence[str(p.relative_to(sdk))] = hashed(p.read_text())
        except (OSError, ValueError):
            continue
    if found == 0:
        evidence['deferred_host_check'] = True
    return evidence


class GuestBusy(RuntimeError):
    """A download/install is in flight; freezing the vCPU now would wedge it."""


def guest_install_busy():
    """True when Play Store / DownloadManager / PackageInstaller has work queued.

    A capture pauses the virtual CPU for the whole disk copy. Doing that mid
    download is the reason installations sat at "Downloading/Pending" forever:
    the DownloadManager connection times out and the install session never
    commits.
    """
    try:
        dl = adb('dumpsys download 2>/dev/null | head -100')
        if re.search(r'Status:\s*(190|192|193|194|195|196)', dl):
            return 'download_manager'
        sessions = adb('dumpsys package installer 2>/dev/null | grep -iE "session|active=" | head -30')
        if re.search(r'active=true|sealed=true', sessions):
            return 'package_installer'
        # An idle Play Store screen is not a reason to skip a checkpoint; only an
        # actual download/install session defers it (checked above).
        return None
    except Exception:
        return None


def _apparent_bytes(path):
    """Total apparent size of the files under `path` (sparse files read as holes)."""
    total = 0
    for p in Path(path).rglob('*'):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            pass
    return total


def resume_guest(attempts=4):
    """Start the vCPU again and CONFIRM it. Returning without a confirmed resume
    is what left the phone frozen: adb then reads "offline", the supervisor kills
    the emulator and relaunches it, and the freeze looks like a random hang."""
    last = None
    for i in range(attempts):
        try:
            console('avd', 'start')
            time.sleep(2 + i)
            status = console('avd', 'status').lower()
            if 'stopped' not in status:
                print('[capture] vCPU resumed (attempt %d, status=%s)'
                      % (i + 1, status.strip().splitlines()[0][:40] if status.strip() else '?'), flush=True)
                return True
            last = 'still stopped per avd status'
        except Exception as e:  # console rejected / adb dropped
            last = str(e)[:200]
        time.sleep(3 * (i + 1))
    raise ResumeFailed('emulator refused to resume after %d attempts (%s); '
                       'the VM is stuck paused and must be relaunched' % (attempts, last))


def capture(avd, destination, hold=False):
    avd = Path(avd).resolve(); destination = Path(destination).resolve()
    if not (avd/'config.ini').is_file():
        raise ValueError('AVD config missing')
    if not list(avd.glob('userdata*')):
        raise ValueError('Refusing snapshot without actual userdata disks')
    if destination.is_relative_to(avd):
        raise ValueError('Archive must not be stored inside its own source AVD')
    if not hold:
        busy = guest_install_busy()
        if busy:
            raise GuestBusy('guest busy (%s); checkpoint deferred so the install/download is not frozen' % busy)
    evidence = {'schema': 2, 'guest': guest_evidence(), 'sdk': sdk_evidence(),
                'avd_name': avd.name.removesuffix('.avd'), 'snapshot': None,
                'format': 'whole-avd-v2-disk-only',
                'created_at': int(time.time()), 'source_held': bool(hold)}
    if not evidence['guest']['boot']:
        raise RuntimeError('Unbooted Android is not a valid checkpoint')
    destination.parent.mkdir(parents=True, exist_ok=True)
    # ROOT CAUSE of "generation never advances": the runner has one AVD worth of
    # free disk, not two. The old flow copied the whole AVD (several GB) into a
    # /tmp staging dir and only then compressed it, which died with
    #   rsync: write failed on ".../userdata-qemu.img.qcow2": Disk quota exceeded (122)
    # so no checkpoint was ever published and every rotation threw the installs
    # away. Default is now a single pass: the guest is paused and the live disks
    # are streamed straight into the compressed archive (tar --sparse -> zstd),
    # which needs room for the archive only. Set VIBELY_CHECKPOINT_DIRECT=0 to get
    # the old staging flow back on a runner that has the space.
    direct = os.environ.get('VIBELY_CHECKPOINT_DIRECT', '1') != '0'
    with tempfile.TemporaryDirectory(prefix='vibely-avd-meta-') as tmp:
        os.chmod(tmp, 0o700)
        stage = Path(tmp)/'avd'
        # A production Google Play image authorizes this HOST key. A new runner
        # with a different ADB key is legitimately unauthorized after restore.
        # Keep the key only inside the encrypted archive, never in logs/artifacts.
        host_keys = Path(tmp)/'host-adb'
        host_keys.mkdir(mode=0o700)
        android_home = Path(os.environ.get('ANDROID_USER_HOME', str(Path.home()/'.android')))
        for name in ('adbkey', 'adbkey.pub'):
            key = android_home/name
            if not key.is_file():
                raise RuntimeError('Original ADB host key missing; portable restore refused')
            shutil.copyfile(key, host_keys/name)
            os.chmod(host_keys/name, 0o600)
        # The manifest is written BEFORE the pause: guest_evidence() talks to adb,
        # which is unavailable while the vCPU is stopped.
        Path(tmp, 'manifest.json').write_text(json.dumps(evidence, sort_keys=True))
        # Junk that must not travel: RAM snapshots, per-boot temp dirs, locks.
        excluded = ['avd/snapshots', 'avd/tmpAdbCmds', 'avd/modem_simulator', '*.lock']
        excluded += os.environ.get('VIBELY_CHECKPOINT_EXTRA_EXCLUDES', '').split()
        excluded = tuple(e for e in excluded if e)
        partial = destination.with_suffix(destination.suffix + '.partial')
        free = shutil.disk_usage(destination.parent).free
        if direct:
            apparent = _apparent_bytes(avd)
            print('[capture] direct stream: avd apparent=%dB, free on destination fs=%dB'
                  % (apparent, free), flush=True)
            if free < 1024**3:
                raise RuntimeError('Refusing checkpoint: only %dB free next to %s; the archive '
                                   'needs >1GB (runner disk exhausted)' % (free, destination))
        stopped = False
        pause_started = 0.0
        try:
            run('sync')
            pause_started = time.time()
            console('avd', 'stop'); stopped = True
            if 'stopped' not in console('avd', 'status').lower():
                raise RuntimeError('VM pause not confirmed; refusing live disk copy')
            run('sync')
            # Full AVD disks: userdata, metadata/encryption/keystore, SD card,
            # hardware config and qcow2 overlays travel together. The guest is
            # paused, therefore the read is crash-consistent and boots cold.
            if direct:
                # One pass, no staging copy. Multiple -C keeps the archive layout
                # identical to the old flow: avd/..., manifest.json, host-adb/....
                run('tar', '--sparse', '--use-compress-program=zstd -1 -T0', '-cf', str(partial),
                    *[f'--exclude={e}' for e in excluded],
                    '--transform=s,^%s,avd,' % re.escape(avd.name),
                    '-C', str(avd.parent), avd.name,
                    '-C', str(tmp), 'manifest.json', 'host-adb', timeout=2400)
                os.chmod(partial, 0o600)
            else:
                # Legacy two-pass flow (needs a second AVD worth of disk).
                stage.mkdir(parents=True, exist_ok=True)
                if shutil.which('rsync'):
                    run('rsync', '-a', '--sparse', *[f'--exclude={e.split("/")[-1]}' for e in excluded],
                        str(avd) + '/', str(stage) + '/', timeout=900)
                else:
                    run('cp', '-a', '--reflink=auto', str(avd), str(stage), timeout=900)
                shutil.rmtree(stage/'snapshots', ignore_errors=True)
                for p in list(stage.rglob('*')):
                    if p.name.endswith('.lock'):
                        try:
                            if p.is_dir(): shutil.rmtree(p)
                            else: p.unlink()
                        except OSError:
                            pass
        except BaseException:
            # --hold is only valid after a SUCCESSFUL capture. Any failed
            # capture must release the original phone, including copy errors.
            partial.unlink(missing_ok=True)
            if stopped and hold:
                console('avd', 'start')
            raise
        finally:
            if stopped and not hold:
                # Resume FIRST and never swallow the failure: a guest left paused is a
                # frozen phone, and the supervisor then fights it with relaunches.
                resumed = resume_guest()
                pause_len = time.time() - pause_started
                print('[capture] guest resumed after %.1fs of vCPU pause' % pause_len, flush=True)
                # A multi-GB archive keeps the vCPU stopped for minutes; give the guest
                # a real chance to answer adb before declaring it dead (it used to be 90s).
                grace = int(os.environ.get('VIBELY_RESUME_GRACE_SEC', '240'))
                if not guest_responding(grace):
                    raise ResumeFailed(
                        'guest did not answer adb %ss after a CONFIRMED resume (pause was %.0fs too long); '
                        'the emulator must be relaunched' % (grace, pause_len))
            elif stopped and hold:
                print('[capture] guest left paused (hold=true) after %.1fs'
                      % (time.time() - pause_started))
        try:
            if not direct:
                run('tar', '--sparse', '--use-compress-program=zstd -1 -T0', '-cf', str(partial),
                    '-C', str(tmp), 'avd', 'manifest.json', 'host-adb', timeout=900)
                os.chmod(partial, 0o600)
            # Validate the entire compressed stream, not merely archive headers.
            run('zstd', '-t', str(partial), timeout=900)
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
        host_sdk = sdk_evidence()
        man_sdk = manifest.get('sdk') or {}
        man_fam = man_sdk.get('family') or os.environ.get('ANDROID_CHECKPOINT_IMAGE_FAMILY', 'google_apis_playstore')
        host_fam = host_sdk.get('family') or os.environ.get('ANDROID_CHECKPOINT_IMAGE_FAMILY', 'google_apis_playstore')
        if man_fam != host_fam:
            raise RuntimeError('System-image family changed; explicit migration required: %s vs %s' % (man_fam, host_fam))
        if man_sdk and host_sdk and not host_sdk.get('deferred_host_check'):
            overlap = set(man_sdk) & set(host_sdk) - {'family', 'api', 'arch', 'deferred_host_check'}
            mismatches = [k for k in overlap if man_sdk.get(k) != host_sdk.get(k)]
            if mismatches:
                # ROOT CAUSE: GitHub's ubuntu-latest image bumps the emulator /
                # system-image package regularly. Treating that byte-level drift
                # as fatal aborted the restore and the phone never came back.
                # The AVD disks are compatible for a matching image family + API +
                # arch (already enforced above), so version drift is evidence only.
                print('[extract] WARNING: emulator/system-image build differs from checkpoint (%s); '
                      'disks are family/API compatible, continuing.' % ','.join(sorted(mismatches)))
        # Disk-only checkpoints are the supported format: the guest is paused while
        # the disks are read, so the image is crash-consistent and boots cold.
        # RAM snapshots are no longer required (and are no longer loaded).
        #
        # Layout tolerance: the canonical layout stores the disks under `avd/`, but
        # the single-pass capture stores them under the AVD's real directory name
        # (e.g. vibely_pixel6_api34.avd/). Accept either, otherwise a perfectly good
        # checkpoint is rejected as "no userdata disk" and the phone never boots.
        restored = Path(tmp, 'avd')
        if not list(restored.glob('userdata*')):
            cands = [p for p in Path(tmp).iterdir() if p.is_dir() and list(p.glob('userdata*'))]
            if len(cands) == 1:
                restored = cands[0]
                print('[extract] AVD stored as %s/; using it as the restore root.' % restored.name)
            elif list(Path(tmp).glob('userdata*')):
                restored = Path(tmp)
        if not list(restored.glob('userdata*')):
            raise ValueError('Checkpoint is not a complete AVD (no userdata disk)')
        # Never overwrite a preexisting phone implicitly, even on a failed restore.
        if avd.exists():
            raise RuntimeError('Destination already exists; explicit isolated destination required')
        # Done before starting this isolated runner's ADB server/emulator.
        # Refuse legacy archives without authorized host keys; do not weaken adbd.
        host_keys = Path(tmp)/'host-adb'
        if not all((host_keys/name).is_file() for name in ('adbkey', 'adbkey.pub')):
            raise RuntimeError('Checkpoint lacks original authorized ADB host identity')
        android_home = Path(os.environ.get('ANDROID_USER_HOME', str(Path.home()/'.android')))
        android_home.mkdir(parents=True, exist_ok=True)
        # adb may not be on PATH yet during pre-emulator restore step
        if shutil.which('adb'):
            subprocess.run(['adb', 'kill-server'], capture_output=True, timeout=20)
        else:
            print('[extract] adb not on PATH yet; restoring host keys without kill-server')
        for name in ('adbkey', 'adbkey.pub'):
            shutil.copyfile(host_keys/name, android_home/name)
            os.chmod(android_home/name, 0o600)
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
            'tiktok_installed': current['tiktok_installed'],
            'account_count_before': wanted['account_count'], 'account_count_after': current['account_count'],
            'android_id_match': current['android_id_hash'] == wanted['android_id_hash'],
            'permissions_match': current['permissions_hash'] == wanted['permissions_hash']}


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
