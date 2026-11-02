#!/usr/bin/env python3
"""Restore ONLY a native-verified recovery checkpoint, never a fresh phone.
Do not displace a working source. This is emergency timeout recovery, NOT proof
of lossless 4-hour overlapping production rotation or genuine Play migration.
"""
import json,os,subprocess,time
from pathlib import Path
import requests
import github_state as gs
from avd_checkpoint import extract,verify
store=gs.Store();target=gs.BRANCH;seed=os.environ['RECOVERY_SEED_BRANCH'];avd=Path(os.environ['AVD_DIR']);archive=Path('/tmp/verified-recovered-avd.tar.zst');owner=os.environ['EMULATOR_SESSION_ID'];base=os.environ['EMULATOR_GATEWAY_URL'].rstrip('/');original_run=os.environ.get('ORIGINAL_SOURCE_RUN','41424314059')
for _ in range(150):
 try:
  gs.BRANCH=seed;_,state=store.read();cp=state.get('current')
  if cp:
   manifest=store.restore_checkpoint(cp,archive)
   if manifest['metadata']['guest']['account_count']<1 or not manifest['metadata'].get('recovered_from_guest_rescue'):raise ValueError('Not a native-tested signed-in recovery')
   break
 except requests.HTTPError as e:
  if e.response.status_code!=404:raise
 finally:gs.BRANCH=target
 time.sleep(10)
else:raise RuntimeError('Native-verified recovered checkpoint was not published; refusing blank substitute')
extract(archive,avd)
# Prepare disk/RAM before expiry, but don't boot a duplicate online account while
# the working source remains. A transient tunnel disconnect is NOT source death.
for _ in range(180):
 source=store.api('GET','/actions/runs/'+original_run)
 health=requests.get(base+'/api/public/health',timeout=20).json()
 if source['status']=='completed' and not health.get('active_session_id'):break
 if health.get('active_session_id') and health.get('active_github_run_id')!=original_run:raise RuntimeError('Another live phone already owns the gateway; preserving it')
 time.sleep(5)
else:raise RuntimeError('Original still alive; emergency recovery did not replace it')
subprocess.run(['adb','start-server'],check=True,capture_output=True,timeout=30)
log=open('/tmp/recovered-live-emulator.log','wb')
proc=subprocess.Popen(['emulator','-avd','vibely_pixel6_api34','-no-window','-gpu','swiftshader_indirect','-no-audio','-no-boot-anim','-snapshot','vibely-checkpoint','-no-snapshot-save','-memory','4096'],stdout=log,stderr=subprocess.STDOUT)
try:
 for _ in range(105):
  if proc.poll() is not None:raise RuntimeError('Verified recovered emulator exited')
  q=subprocess.run(['adb','shell','getprop sys.boot_completed'],capture_output=True,text=True,timeout=20)
  if q.returncode==0 and q.stdout.strip()=='1':break
  time.sleep(4)
 else:raise RuntimeError('Native recovered boot deadline exceeded')
 proof=verify(manifest['metadata']);required=('boot','display','packages','account_hash','settings','userdata','foreground')
 if not all(proof.get(k) is True for k in required):raise RuntimeError('Recovered native verification failed: '+json.dumps(proof))
 print(json.dumps({'event':'VERIFIED_RECOVERED_PHONE_READY','account_count':proof['account_count_after'],'native_checks':{k:proof[k] for k in required},'official_play_image':False,'not_lossless_production_rotation':True}),flush=True)
 # Adopt a valid existing checkpoint into this recovery-only writer branch.
 store.initialize(owner);head,state=store.owner(owner);state.update(current=cp,generation=1);store.cas(head,state)
 subprocess.run(['node','android-emulator/agent.mjs'],check=True)
finally:
 subprocess.run(['adb','emu','kill'],capture_output=True,timeout=30)
