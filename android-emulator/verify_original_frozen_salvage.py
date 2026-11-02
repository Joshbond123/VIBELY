#!/usr/bin/env python3
"""Accept ONLY exact original frozen whole-volume equality, never mixed epochs."""
import concurrent.futures,gzip,hashlib,json,struct
from pathlib import Path
from github_state import Store,decrypt,encrypt
s=Store();release=s.api('GET','/releases/431616525')
if not release['draft']:raise RuntimeError('Refusing published checkpoint mutation')
proof=json.loads(Path(__file__).with_name('original_frozen_salvage_proof.json').read_text())
a=next(a for a in release['assets'] if a['name']=='untrusted-precopy-41473320772.gcm')
def desc(a):return {'id':a['id'],'name':a['name'],'bytes':a['size'],'sha256':a['digest'].split(':')[-1]}
p=json.loads(decrypt(s.download_asset(desc(a)),s.password))
assert p['UNTRUSTED'] is True
assert set(v['device'] for v in p['volumes'])==set(proof['source_hashes'])
def raw(part):
 data=decrypt(s.download_asset(part['asset']),s.password);i=0;out=[];h=hashlib.sha256();n=0
 while i<len(data):
  if i+4>len(data):raise ValueError('Record length truncated')
  k=struct.unpack_from('<I',data,i)[0];i+=4
  if k>16*1024*1024 or i+k>len(data):raise ValueError('Record bounds')
  b=gzip.decompress(data[i:i+k]);i+=k;h.update(b);n+=len(b);out.append(b)
 if h.hexdigest()!=part['raw_sha256'] or n!=part['raw_bytes']:raise ValueError('Part readback integrity failed')
 return b''.join(out)
for v in p['volumes']:
 h=hashlib.sha256();n=0
 with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
  for start in range(0,len(v['parts']),16):
   for b in pool.map(raw,v['parts'][start:start+16]):h.update(b);n+=len(b)
 if n!=v['bytes'] or h.hexdigest()!=proof['source_hashes'][v['device']]:raise ValueError('ORIGINAL FROZEN WHOLE VOLUME MISMATCH: '+v['device'])
 v['sha256']=h.hexdigest();print(json.dumps({'event':'ORIGINAL_FROZEN_WHOLE_VOLUME_READBACK_MATCH','device':v['device']}),flush=True)
meta=p['metadata'];meta.update(proof['expected_account']);meta.update(created_at=1793629701,source_freeze_at=proof['source_freeze_at'],source_freeze_run=proof['source_freeze_run'],untrusted_precopy_frozen_reconciliation=False,restoration_tested=False,latest_writes_preserved=False,checkpoint_age_warning='Original 14:28 UTC frozen checkpoint, NOT current latest writes',account_hash_expected_from_current_source=True)
m={'metadata':meta,'volumes':p['volumes'],'source_and_download_hashes_match':True,'source_hash_method':'independent ORIGINAL FROZEN whole volume hashes from run 41461984062; every byte read back from GitHub and compared','restoration_tested':False,'referenced_release_dependencies':[431560693]}
a=s.upload_asset(release,'manifest.gcm',encrypt(json.dumps(m).encode(),s.password))
assert json.loads(decrypt(s.download_asset(a),s.password))==m
s.api('PATCH','/releases/431616525',json={'draft':False,'body':'Verified ORIGINAL 14:28 UTC FROZEN guest disk checkpoint: all six independently frozen whole-volume source hashes equal authenticated GitHub readback. Older checkpoint, NOT latest writes. Guest disks only, NOT whole AVD. Native signed-in restoration pending. Dependency 431560693 MUST NOT be deleted.'})
print(json.dumps({'event':'PUBLISHED_VERIFIED_ORIGINAL_FROZEN_CHECKPOINT','release_id':431616525,'checkpoint_at':proof['source_freeze_at'],'latest_writes_preserved':False}),flush=True)
