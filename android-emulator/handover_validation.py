#!/usr/bin/env python3
"""Two real, isolated Actions VMs. Never connects to/replaces the public phone.
This validates the final-checkpoint/ownership protocol, NOT Google/TikTok UI.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path
import requests
import github_state as gs
from avd_checkpoint import capture, console, extract, verify, adb

ROLE=sys.argv[1]
RUN=os.environ['GITHUB_RUN_ID']
A,B=RUN+':A',RUN+':B'
AVD=Path(os.environ['AVD_DIR'])
ARCHIVE=Path('/tmp/handover.tar.zst')
REQUIRED=('boot','display','packages','account_hash','settings','userdata','foreground')
LATE='late-write-after-candidate-first-boot-'+RUN
PROC=None

def emit(event, **data): print(json.dumps({'event':event,**data}),flush=True)
def stop():
 global PROC
 subprocess.run(['adb','emu','kill'],capture_output=True,timeout=20)
 if PROC:
  try:PROC.wait(timeout=60)
  except subprocess.TimeoutExpired:PROC.kill();PROC.wait(timeout=20)
  PROC=None

def boot(store, checkpoint):
 global PROC
 manifest=store.restore_checkpoint(checkpoint,ARCHIVE)
 # Refuse to use any private/signed-in phone as a disposable validation fixture.
 if manifest['metadata']['guest']['account_count'] != 0:
  raise RuntimeError('Isolated test refuses a signed-in seed phone')
 if AVD.exists():shutil.rmtree(AVD)
 extract(ARCHIVE,AVD)
 log=open('/tmp/handover-emulator.log','a')
 subprocess.run(['adb','start-server'],check=True,capture_output=True,timeout=20)
 PROC=subprocess.Popen(['emulator','-avd','vibely_disk_validation','-no-window','-gpu','swiftshader_indirect','-no-audio','-no-boot-anim','-snapshot','vibely-checkpoint','-no-snapshot-save','-memory','3072'],stdout=log,stderr=subprocess.STDOUT)
 deadline=time.monotonic()+420
 while time.monotonic()<deadline:
  try:
   if adb('getprop sys.boot_completed')=='1':break
  except subprocess.CalledProcessError:pass
  if PROC.poll() is not None:raise RuntimeError('Restored VM exited')
  time.sleep(4)
 else:raise RuntimeError('Restored VM boot deadline exceeded')
 proof=verify(manifest['metadata'])
 if not all(proof.get(k) is True for k in REQUIRED):raise RuntimeError('Native restored checkpoint verification failed: '+json.dumps(proof))
 return proof

def await_state(store, predicate, seconds=1500):
 deadline=time.monotonic()+seconds
 while time.monotonic()<deadline:
  try:
   head,state=store.read()
   if predicate(state):return head,state
  except requests.HTTPError as e:
   if e.response.status_code!=404:raise
  time.sleep(10)
 raise RuntimeError('Bounded handover state deadline exceeded')

store=gs.Store()
try:
 if ROLE=='source':
  target=gs.BRANCH;gs.BRANCH=os.environ['SEED_BRANCH']
  _,seed=store.read();checkpoint=seed['current']
  proof=boot(store,checkpoint);gs.BRANCH=target
  store.initialize(A)
  adb('echo baseline-before-candidate > /sdcard/Download/handover-marker.txt')
  metadata=capture(AVD,ARCHIVE)
  first=store.publish(ARCHIVE,A,metadata)
  store.prepare(A,B)
  emit('source_live_candidate_may_prewarm')
  await_state(store,lambda s:(s.get('pending') or {}).get('baseline_ready') is True)
  # This write happens AFTER candidate B has really booted the older disk.
  adb('echo '+LATE+' > /sdcard/Download/handover-marker.txt')
  metadata=capture(AVD,ARCHIVE,hold=True)
  if 'stopped' not in console('avd','status').lower():raise RuntimeError('Final source pause missing')
  final=store.publish(ARCHIVE,A,metadata)
  store.prepare(A,B,source_held=True)
  emit('source_held_final_latest_writes_committed')
  await_state(store,lambda s:s['owner']==B)
  try:store.owner(A)
  except gs.Conflict:emit('old_writer_fenced',passed=True)
  else:raise RuntimeError('Old writer not fenced')
  stop();emit('source_stopped_only_after_candidate_promoted',passed=True)
 elif ROLE=='candidate':
  _,state=await_state(store,lambda s:bool(s.get('current')))
  initial=state['current'];boot(store,initial)
  head,state=store.read();pending=state.get('pending') or {}
  if pending.get('candidate')!=B or pending.get('checkpoint')!=initial:raise RuntimeError('Candidate prewarm lock changed')
  pending['baseline_ready']=True;store.cas(head,state)
  emit('candidate_initial_real_boot_ready')
  _,state=await_state(store,lambda s:(s.get('pending') or {}).get('source_held') is True and s['current']!=initial)
  final=state['current'];stop();proof=boot(store,final)
  if adb('cat /sdcard/Download/handover-marker.txt')!=LATE:raise RuntimeError('LATEST WRITE LOST')
  if state.get('owner')!=A:raise RuntimeError('Candidate became writer before verification')
  store.promote(B,final,proof)
  emit('candidate_ready_atomic_owner_transfer',latest_write_preserved=True,native_verification=proof)
  deadline=time.monotonic()+240
  while time.monotonic()<deadline:
   jobs=store.api('GET','/actions/runs/'+RUN+'/jobs')
   source=next((j for j in jobs['jobs'] if j['name']=='source-A'),None)
   if source and source['status']=='completed':
    if source['conclusion']!='success':raise RuntimeError('Source did not terminate cleanly after promotion')
    break
   time.sleep(5)
  else:raise RuntimeError('Source stop not confirmed')
  if adb('cat /sdcard/Download/handover-marker.txt')!=LATE:raise RuntimeError('Candidate data changed after source termination')
  emit('PASS_REAL_A_TO_B_TO_A_STOP',public_phone_untouched=True,google_tiktok_notes_ui_not_tested=True)
 else:raise ValueError('Unknown role')
except BaseException:
 if ROLE=='source':
  # Clear authorization BEFORE resuming A. If ownership/network is uncertain,
  # fail closed rather than resurrect a possible fenced writer.
  try:
   head,state=store.owner(A);state['pending']=None;store.cas(head,state)
   console('avd','start');emit('failed_candidate_authorization_revoked_source_resumed')
  except Exception:emit('source_resume_refused_when_ownership_uncertain')
 raise
finally:
 # Only isolated disposable test VMs, never the public phone, are cleaned up.
 stop()
