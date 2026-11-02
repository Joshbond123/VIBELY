#!/usr/bin/env python3
"""User-approved emergency frozen guest-disk rescue, NOT a full AVD/RAM snapshot.
Credentials remain on the Actions receiver. Nothing is committed from phone data.
"""
import base64, concurrent.futures, gzip, hashlib, json, os, signal, struct, time, uuid
import requests, re
from github_state import Store, encrypt, decrypt

BASE=os.environ['EMULATOR_GATEWAY_URL'].rstrip('/')
SOURCE=os.environ['RESCUE_SOURCE_SESSION']
HEADERS={'Authorization':'Bearer '+os.environ['EMULATOR_GATEWAY_SECRET']}
HELPER='/data/local/tmp/vibely-freeze'
CHUNK=2*1024*1024
store=Store()
release=None;frozen=False

def emit(event,**kw):print(json.dumps({'event':event,**kw}),flush=True)
def rpc(command,retry=False):
 for attempt in range(12 if retry else 1):
  try:
   r=requests.post(BASE+'/api/internal/recovery/rpc',headers=HEADERS,json={'session_id':SOURCE,'command':command},timeout=(15,60))
   r.raise_for_status();d=r.json()
   if not d.get('ok') or d.get('session_id')!=SOURCE:raise RuntimeError('RPC target changed or source failed')
   return d.get('stdout','')
  except requests.RequestException:
   if not retry or attempt==11:raise
   time.sleep(3)
def interrupted(*_):raise SystemExit('Receiver interrupted; source thaw attempted')
signal.signal(signal.SIGTERM,interrupted)

try:
 h=requests.get(BASE+'/api/public/health',timeout=20).json()
 if h.get('active_session_id')!=SOURCE and not any(q.get('session_id')==SOURCE for q in h.get('standby_sessions',[])):raise RuntimeError('Original source is disconnected; refusing to touch a replacement')
 serials=rpc('for x in vda vdb vdc vdd vde vdf; do echo "$x $(cat /sys/block/$x/size) $(cat /sys/block/$x/serial 2>/dev/null)"; done')
 volumes=[]
 for line in serials.splitlines():
  v=line.split()
  if len(v)<2 or v[0] not in ['vda','vdb','vdc','vdd','vde','vdf']:raise RuntimeError('Unexpected block inventory')
  volumes.append({'device':v[0],'bytes':int(v[1])*512,'serial':' '.join(v[2:])})
 if len(volumes)!=6:raise RuntimeError('Incomplete virtual-disk inventory')
 # Hashes/foreground are kept inside the encrypted manifest, never printed.
 metadata={'fingerprint':rpc('getprop ro.build.fingerprint').strip(),
           'foreground':rpc('dumpsys activity activities | grep ResumedActivity').strip(),
           'source_session':SOURCE,'source_kind':'existing-root-userdebug',
           'format':'guest-disks-v1-NOT-FULL-AVD','ram_included':False,'host_configuration_included':False,
           'created_at':int(time.time()),'account_restoration_tested':False}
 tag='android-guest-rescue-'+os.environ['GITHUB_RUN_ID']+'-'+uuid.uuid4().hex[:8]
 release=store.api('POST','/releases',json={'tag_name':tag,'target_commitish':'main','name':tag,'draft':True,'prerelease':True,
   'body':'User-approved encrypted frozen guest-disk recovery. NOT a full AVD/RAM snapshot. Restore not yet tested.'})
 account_dump=rpc('dumpsys account')
 accounts='\n'.join(sorted(re.findall(r'^\s*Account \{name=([^}]+)\}\s*$',account_dump,re.M)))
 counts=re.findall(r'^\s*Accounts:\s*(\d+)\s*$',account_dump,re.M)
 if not counts or sum(map(int,counts))!=len(accounts.splitlines()) or not accounts:raise RuntimeError('Signed-in account proof incomplete; rescue not started')
 metadata['account_count']=len(accounts.splitlines());metadata['account_hash']=hashlib.sha256(accounts.encode()).hexdigest()
 # Bound frozen-state diagnostic CLI waits without stopping framework/apps.
 rpc('touch /dev/vibely-fastdiag-stop; sleep 1; rm /dev/vibely-fastdiag-stop; nohup sh /dev/vibely-fastdiag.sh >/dev/null 2>&1 </dev/null & echo DIAGNOSTIC_GUARD_STARTED')
 # An old short-test watchdog must not thaw this new freeze.
 rpc('if test -f /dev/vibely-rescue-watchdog.pid; then p=$(cat /dev/vibely-rescue-watchdog.pid); case "$(readlink /proc/$p/exe 2>/dev/null)" in */vibely-freeze) kill "$p" 2>/dev/null || true;; esac; fi; '+HELPER+' thaw')
 frozen=True # An ambiguous freeze response must still trigger emergency thaw.
 out=rpc(HELPER+' freeze 3600')
 if 'FROZEN' not in out:raise RuntimeError('Source freeze not confirmed')
 frozen=True;emit('SOURCE_FILESYSTEMS_FROZEN',watchdog_seconds=3600,release_id=release['id'])
 # Independent source-side hashes: not merely hashes calculated from received data.
 rpc("nohup sh -c 'for x in vdb vdd vde vdc vdf vda; do sha256sum /dev/block/$x; done > /dev/vibely-rescue-source-sha256; touch /dev/vibely-rescue-hashes-done' >/dev/null 2>&1 </dev/null & echo HASH_WORKER_STARTED")
 # Small key/metadata disks first, then userdata. Read-only system last.
 order={'vdb':0,'vdd':1,'vde':2,'vdc':3,'vdf':4,'vda':5}
 volumes.sort(key=lambda v:order[v['device']])
 def fetch_chunk(arg):
  device,index,expected=arg
  text=rpc(f'dd if=/dev/block/{device} bs={CHUNK} skip={index} count=1 2>/dev/null | gzip -1 | base64 -w 0',retry=True)
  compressed=base64.b64decode(text,validate=True);raw=gzip.decompress(compressed)
  if len(raw)!=expected:raise RuntimeError('Short or invalid raw block read')
  return compressed,raw
 def bounded_fetch(executor,args):
  for start in range(0,len(args),16):
   yield from executor.map(fetch_chunk,args[start:start+16])
 for volume in volumes:
  device=volume['device']
  if device=='vda' and frozen:
   # vda is the read-only system image. Its independent frozen-time hash is
   # compared below; thaw writable volumes before copying unchanged RO bytes.
   out=rpc(HELPER+' thaw; touch /dev/vibely-fastdiag-stop')
   if 'THAWED' not in out:raise RuntimeError('Source thaw not confirmed')
   frozen=False;emit('SOURCE_THAWED_COPYING_READONLY_SYSTEM')
  remaining=volume['bytes'];count=(remaining+CHUNK-1)//CHUNK
  vh=hashlib.sha256();volume['parts']=[];part=bytearray();part_raw=0;part_hash=hashlib.sha256()
  args=[(device,i,min(CHUNK,remaining-i*CHUNK)) for i in range(count)]
  with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
   for index,(compressed,raw) in enumerate(bounded_fetch(executor,args)):
    vh.update(raw);part_hash.update(raw);part_raw+=len(raw)
    part.extend(struct.pack('<I',len(compressed)));part.extend(compressed)
    if (index+1)%16==0 or index==count-1:
     if frozen and 'FROZEN_OK' not in rpc('test ! -e /dev/vibely-rescue-watchdog-fired && echo FROZEN_OK'):raise RuntimeError('Watchdog fired: mixed-time backup rejected')
     number=len(volume['parts']);encrypted=encrypt(bytes(part),store.password)
     asset=store.upload_asset(release,f'{device}-{number:05d}.gcm',encrypted)
     volume['parts'].append({'asset':asset,'raw_bytes':part_raw,'raw_sha256':part_hash.hexdigest(),'encoding':'gzip-records-le32'})
     emit('ENCRYPTED_PART_UPLOADED',device=device,raw_mib=round((index+1)*CHUNK/1048576),part=number)
     part=bytearray();part_raw=0;part_hash=hashlib.sha256()
  volume['sha256']=vh.hexdigest();emit('VOLUME_CAPTURED',device=device,bytes=volume['bytes'])
 if 'SOURCE_HASHES_READY' not in rpc('test -f /dev/vibely-rescue-hashes-done && echo SOURCE_HASHES_READY'):raise RuntimeError('Independent source hashes incomplete')
 hashes={line.split()[1].split('/')[-1]:line.split()[0] for line in rpc('cat /dev/vibely-rescue-source-sha256').splitlines()}
 for v in volumes:
  if hashes.get(v['device'])!=v['sha256']:raise RuntimeError('Source/receiver whole-volume hash mismatch')
 if frozen and 'FROZEN_OK' not in rpc('test ! -e /dev/vibely-rescue-watchdog-fired && echo FROZEN_OK'):raise RuntimeError('Freeze deadline exceeded')
 out=rpc(HELPER+' thaw; touch /dev/vibely-fastdiag-stop')
 if 'THAWED' not in out:raise RuntimeError('Source thaw not confirmed')
 frozen=False;emit('SOURCE_THAWED_VOLUME_HASHES_MATCH')
 # Authenticated GitHub read-back after thaw minimizes the pause on the real phone.
 for v in volumes:
  full=hashlib.sha256()
  for part in v['parts']:
   data=decrypt(store.download_asset(part['asset']),store.password);offset=0;ph=hashlib.sha256();n=0
   while offset<len(data):
    size=struct.unpack_from('<I',data,offset)[0];offset+=4;raw=gzip.decompress(data[offset:offset+size]);offset+=size
    ph.update(raw);full.update(raw);n+=len(raw)
   if n!=part['raw_bytes'] or ph.hexdigest()!=part['raw_sha256']:raise RuntimeError('GitHub part read-back mismatch')
  if full.hexdigest()!=v['sha256']:raise RuntimeError('GitHub whole-volume read-back mismatch')
  emit('GITHUB_VOLUME_AUTHENTICATED',device=v['device'])
 manifest={'metadata':metadata,'volumes':volumes,'source_and_download_hashes_match':True,'restoration_tested':False}
 ma=store.upload_asset(release,'manifest.gcm',encrypt(json.dumps(manifest).encode(),store.password))
 if json.loads(decrypt(store.download_asset(ma),store.password))!=manifest:raise RuntimeError('Manifest read-back mismatch')
 store.api('PATCH','/releases/'+str(release['id']),json={'draft':False})
 emit('ENCRYPTED_GUEST_DISK_RESCUE_COMPLETE',release_id=release['id'],tag=tag,restore_tested=False,full_avd=False)
finally:
 if frozen:
  try:emit('EMERGENCY_THAW',result='THAWED' in rpc(HELPER+' thaw; touch /dev/vibely-fastdiag-stop'))
  except Exception:emit('THAW_RPC_FAILED_WATCHDOG_REMAINS',seconds_max=3600)
