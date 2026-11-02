#!/usr/bin/env python3
"""Live PRECOPY is untrusted. Only a <=120-second frozen reconciliation can
produce an accepted emergency guest-disk checkpoint. No source wipe/replacement.
This remains NOT a whole AVD; original host configuration/RAM/key are unavailable.
"""
import base64,concurrent.futures,gzip,hashlib,json,os,re,signal,struct,time,uuid
from pathlib import Path
import requests
from github_state import Store,encrypt,decrypt
S=Store();BASE=os.environ['EMULATOR_GATEWAY_URL'].rstrip('/');SID='emu_41424314059_c4be3a';HEAD={'Authorization':'Bearer '+os.environ['EMULATOR_GATEWAY_SECRET']};CHUNK=2097152;PART=16*CHUNK;RUN=os.environ['GITHUB_RUN_ID'];HELP='/data/local/tmp/vibely-freeze';frozen=False;freeze_start=0;volumes=[];pending={};root=Path('/tmp/final-guest-rescue');root.mkdir(mode=0o700,exist_ok=True)
def emit(e,**kw):print(json.dumps({'event':e,**kw}),flush=True)
def budget():
 if frozen and time.monotonic()-freeze_start>100:raise TimeoutError('Final freeze budget exhausted; draft rejected')
def rpc(c):
 budget()
 for attempt in range(8):
  try:
   q=requests.post(BASE+'/api/internal/recovery/rpc',headers=HEAD,json={'session_id':SID,'command':c},timeout=(10,45));q.raise_for_status();d=q.json()
   if not d.get('ok') or d.get('session_id')!=SID:raise RuntimeError('Source RPC failed or changed')
   return d.get('stdout','')
  except requests.RequestException:
   if frozen or attempt==7:raise
   time.sleep(2)
def thaw():
 global frozen
 # Never budget-gate emergency thaw itself.
 frozen=False
 q=requests.post(BASE+'/api/internal/recovery/rpc',headers=HEAD,json={'session_id':SID,'command':HELP+' thaw; touch /dev/vibely-fastdiag-stop'},timeout=(10,45));q.raise_for_status()
 if 'THAWED' not in q.json().get('stdout',''):raise RuntimeError('Thaw not confirmed; independent 120s watchdog remains')
 emit('SOURCE_THAWED')
def unpack(blob):
 offset=0;h=hashlib.sha256();n=0
 while offset<len(blob):
  k=struct.unpack_from('<I',blob,offset)[0];offset+=4
  if k>16*1024*1024 or offset+k>len(blob):raise ValueError('Record bounds')
  b=gzip.decompress(blob[offset:offset+k]);offset+=k;h.update(b);n+=len(b)
 return h.hexdigest(),n

def fetch_block(arg):
 d,i,n=arg;text=rpc(f'dd if=/dev/block/{d} bs={CHUNK} skip={i} count=1 2>/dev/null | gzip -1 | base64 -w 0');b=base64.b64decode(text,validate=True);raw=gzip.decompress(b)
 if len(raw)!=n:raise ValueError('Short source block')
 return b,raw

def copy_part(v,index,upload=True):
 budget();start=index*PART;n=min(PART,v['bytes']-start);h=hashlib.sha256();data=bytearray()
 args=[(v['device'],start//CHUNK+i,min(CHUNK,n-i*CHUNK)) for i in range((n+CHUNK-1)//CHUNK)]
 with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
  for compressed,raw in pool.map(fetch_block,args):h.update(raw);data.extend(struct.pack('<I',len(compressed)));data.extend(compressed)
 part={'raw_bytes':n,'raw_sha256':h.hexdigest(),'encoding':'gzip-records-le32'};blob=encrypt(bytes(data),S.password)
 if upload:part['asset']=S.upload_asset(release,f"{v['device']}-{index:05d}-{uuid.uuid4().hex[:5]}.gcm",blob)
 else:
  p=root/f"{v['device']}-{index:05d}.gcm";p.write_bytes(blob);os.chmod(p,0o600);pending[(v['device'],index)]=p
 return part

def hashes():
 name='/dev/vibely-final-hash-'+RUN
 # Toybox xargs has no -P: eight explicit workers, disjoint part indices.
 script='rm -f '+name+' '+name+'.done; for lane in 0 1 2 3 4 5 6 7; do (for d in vda vdb vdc vdd vde vdf; do sectors=$(cat /sys/block/$d/size); count=$(((sectors+65535)/65536)); i=$lane; while [ $i -lt $count ]; do h=$(dd if=/dev/block/$d bs=33554432 skip=$i count=1 2>/dev/null | sha256sum); printf "%s %s %s\\n" "$d" "$i" "${h%% *}" >> '+name+'; i=$((i+8)); done; done) & done; wait; touch '+name+'.done'
 enc=base64.b64encode(script.encode()).decode();rpc("printf '%s' '"+enc+"' | base64 -d > "+name+".sh; nohup sh "+name+".sh >/dev/null 2>&1 </dev/null & echo HASH_SCAN_STARTED")
 began=time.monotonic()
 while True:
  budget()
  if 'DONE' in rpc('test -f '+name+'.done && echo DONE'):break
  if time.monotonic()-began>240:raise TimeoutError('Source hash deadline')
  time.sleep(.5 if frozen else 2)
 rows=rpc('cat '+name).splitlines();result={}
 for line in rows:
  d,i,h=line.split()
  if not re.fullmatch('[0-9a-f]{64}',h) or (d,int(i)) in result:raise ValueError('Invalid/duplicate source hash')
  result[d,int(i)]=h
 expected=sum(len(v['parts']) for v in volumes)
 if len(result)!=expected:raise ValueError('Source hash scan incomplete')
 emit('INDEPENDENT_SOURCE_BLOCK_SCAN',seconds=round(time.monotonic()-began,2),frozen=frozen,blocks=len(result));return result

def reconcile(h,upload=True):
 changed=0
 for v in volumes:
  for i,p in enumerate(v['parts']):
   if p['raw_sha256']==h[v['device'],i]:continue
   changed+=1
   if not upload and changed*PART>512*1024*1024:raise RuntimeError('Final delta too large for bounded pause')
   q=copy_part(v,i,upload)
   if q['raw_sha256']!=h[v['device'],i]:
    if frozen:raise ValueError('Frozen source changed; checkpoint rejected')
    # A live re-read remains UNTRUSTED; final frozen scan is mandatory.
   v['parts'][i]=q
 emit('BLOCKS_RECONCILED',changed=changed,frozen=frozen)

signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(SystemExit('Interrupted')))
try:
 sizes=rpc('for d in vda vdb vdc vdd vde vdf; do echo "$d $(cat /sys/block/$d/size)"; done')
 for row in sizes.splitlines():
  d,n=row.split();n=int(n)*512
  if d not in ('vda','vdb','vdc','vdd','vde','vdf') or n<1:raise ValueError('Unexpected source volume')
  volumes.append({'device':d,'bytes':n,'parts':[None]*((n+PART-1)//PART)})
 if len(volumes)!=6:raise ValueError('Original disk inventory incomplete')
 metadata={'fingerprint':rpc('getprop ro.build.fingerprint').strip(),'source_session':SID,'source_kind':'existing-root-userdebug','format':'guest-disks-v1-NOT-FULL-AVD','ram_included':False,'host_configuration_included':False,'created_at':int(time.time()),'account_restoration_tested':False,'untrusted_precopy_frozen_reconciliation':True}
 tag='android-guest-rescue-final-'+RUN;release=S.api('POST','/releases',json={'tag_name':tag,'target_commitish':'main','name':tag,'draft':True,'prerelease':True,'body':'UNTRUSTED live precopy. Accept only a published authenticated manifest after bounded frozen reconciliation. NOT full AVD.'})
 # Reuse encrypted partial data as UNTRUSTED precopy, not as a valid backup.
 old=S.api('GET','/releases/431560693');bydev={v['device']:v for v in volumes}
 for a in old['assets']:
  match=re.fullmatch(r'(vd[a-f])-(\d+)\.gcm',a['name'])
  if not match:continue
  d,index=match[1],int(match[2]);v=bydev[d]
  desc={'id':a['id'],'name':a['name'],'bytes':a['size'],'sha256':a['digest'].split(':')[-1]};blob=S.download_asset(desc);h,n=unpack(decrypt(blob,S.password))
  if n!=min(PART,v['bytes']-index*PART):raise ValueError('Partial format mismatch')
  v['parts'][index]={'asset':desc,'raw_bytes':n,'raw_sha256':h,'encoding':'gzip-records-le32'}
 emit('UNTRUSTED_PARTIAL_PRECOPY_REUSED',parts=sum(p is not None for v in volumes for p in v['parts']),release_id=release['id'])
 for v in sorted(volumes,key=lambda v:{'vdc':0,'vdf':1,'vdb':2,'vdd':3,'vde':4,'vda':5}[v['device']]):
  for i,p in enumerate(v['parts']):
   if p is None:v['parts'][i]=copy_part(v,i);emit('UNTRUSTED_LIVE_PART',device=v['device'],part=i)
 # Reduce the final delta while the phone remains live; still no accepted state.
 reconcile(hashes())
 dump=rpc('dumpsys account');accounts='\n'.join(sorted(re.findall(r'^\s*Account \{name=([^}]+)\}\s*$',dump,re.M)));counts=re.findall(r'^\s*Accounts:\s*(\d+)\s*$',dump,re.M)
 if not accounts or sum(map(int,counts))!=len(accounts.splitlines()):raise ValueError('Signed-in account proof incomplete')
 metadata.update(account_count=len(accounts.splitlines()),account_hash=hashlib.sha256(accounts.encode()).hexdigest(),foreground=rpc('dumpsys activity activities | grep ResumedActivity').strip())
 rpc('touch /dev/vibely-fastdiag-stop; sleep 1; rm /dev/vibely-fastdiag-stop; nohup sh /dev/vibely-fastdiag.sh >/dev/null 2>&1 </dev/null & echo DIAGNOSTIC_GUARD')
 rpc('if test -f /dev/vibely-rescue-watchdog.pid; then p=$(cat /dev/vibely-rescue-watchdog.pid); case "$(readlink /proc/$p/exe 2>/dev/null)" in */vibely-freeze) kill "$p" 2>/dev/null || true;; esac; fi; '+HELP+' thaw')
 freeze_start=time.monotonic();frozen=True
 if 'FROZEN' not in rpc(HELP+' freeze 120'):raise RuntimeError('Final freeze not confirmed')
 emit('FINAL_FREEZE_STARTED',maximum_seconds=120)
 final=hashes();reconcile(final,upload=False)
 if 'HELD' not in rpc('test ! -e /dev/vibely-rescue-watchdog-fired && echo HELD'):raise ValueError('Watchdog fired; rejecting checkpoint')
 duration=round(time.monotonic()-freeze_start,2);thaw();metadata['final_freeze_seconds']=duration
 # Upload buffered encrypted deltas only AFTER releasing the real phone.
 for v in volumes:
  for i,p in enumerate(v['parts']):
   if 'asset' not in p:p['asset']=S.upload_asset(release,f"{v['device']}-{i:05d}-final.gcm",pending[v['device'],i].read_bytes())
   if p['raw_sha256']!=final[v['device'],i]:raise ValueError('Final manifest does not match frozen source')
  full=hashlib.sha256()
  for p in v['parts']:
   plain=decrypt(S.download_asset(p['asset']),S.password);offset=0;ph=hashlib.sha256();n=0
   while offset<len(plain):
    k=struct.unpack_from('<I',plain,offset)[0];offset+=4;b=gzip.decompress(plain[offset:offset+k]);offset+=k;full.update(b);ph.update(b);n+=len(b)
   if ph.hexdigest()!=p['raw_sha256'] or n!=p['raw_bytes']:raise ValueError('Independent GitHub readback failed')
  v['sha256']=full.hexdigest();emit('GITHUB_VOLUME_AUTHENTICATED',device=v['device'])
 manifest={'metadata':metadata,'volumes':volumes,'source_and_download_hashes_match':True,'source_hash_method':'independent 32MiB frozen block hashes','restoration_tested':False,'referenced_release_dependencies':[431560693]}
 ma=S.upload_asset(release,'manifest.gcm',encrypt(json.dumps(manifest).encode(),S.password))
 if json.loads(decrypt(S.download_asset(ma),S.password))!=manifest:raise ValueError('Manifest readback failed')
 S.api('PATCH','/releases/'+str(release['id']),json={'draft':False,'body':'Authenticated bounded-frozen guest disk checkpoint; full source block and GitHub readback equality verified. NOT full AVD. Restore not yet tested. Dependency release 431560693 MUST NOT be deleted.'})
 emit('PUBLISHED_VERIFIED_GUEST_CHECKPOINT',release_id=release['id'],final_freeze_seconds=duration)
finally:
 if frozen:
  try:thaw()
  except Exception:emit('THAW_TRANSPORT_FAILED_INDEPENDENT_120_SECOND_WATCHDOG_REMAINS')
 else:
  try:rpc('touch /dev/vibely-fastdiag-stop')
  except Exception:pass
