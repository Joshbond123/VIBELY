#!/usr/bin/env python3
"""One genuine website submission, resumable observation, no automatic resubmission.
Does not call a model directly or substitute samples. Refuses inactive engines.
"""
import argparse,hashlib,json,pathlib,subprocess,time
import requests
p=argparse.ArgumentParser();p.add_argument('--base',default='https://aivideo.aivideo.blitz.cloud');p.add_argument('--engine',default='wan_animate_2_distilled_14b');p.add_argument('--series',default='gym_challenge');p.add_argument('--evidence',required=True);p.add_argument('--deadline-minutes',type=int,default=120);a=p.parse_args();path=pathlib.Path(a.evidence);path.parent.mkdir(parents=True,exist_ok=True)
r=json.loads(path.read_text()) if path.exists() else {'generation_id':None,'samples':[],'visual_acceptance':'NOT_REVIEWED'}
def save():path.write_text(json.dumps(r,indent=2))
def get(route):
 q=requests.get(a.base.rstrip('/')+route,timeout=30);q.raise_for_status();return q.json()
try:
 readiness=get('/api/video-engine/readiness');r['engine_readiness']=readiness
 if a.engine!=readiness['current_engine']:
  c=readiness['candidate']
  if a.engine!=c['id'] or not c['activated'] or not c['runtime_validated']:
   r.update(status='BLOCKED_BEFORE_SUBMISSION',error='Requested model is not runtime-validated and active; no video was submitted.');save();raise SystemExit(2)
 if not r.get('generation_id') and r.get('submission_started_unix'):
  raise RuntimeError('Earlier submission outcome is uncertain. Reconcile website history and record its generation_id; automatic duplicate refused.')
 if r.get('requested_engine') and r['requested_engine']!=a.engine:raise RuntimeError('Evidence belongs to a different model')
 r['requested_engine']=a.engine
 if not r.get('generation_id'):
  # Do not blindly retry a POST with an uncertain outcome. Reconcile history.
  r.update(status='SUBMITTING_ONCE',submission_started_unix=time.time());save()
  q=requests.post(a.base.rstrip('/')+'/api/videos/generate',json={'series_id':a.series,'generation_engine':a.engine},timeout=100);q.raise_for_status();r['generation_id']=q.json()['generation_id'];save()
 began=time.monotonic()
 while time.monotonic()-began<a.deadline_minutes*60:
  v=get('/api/videos/'+r['generation_id'])['video'];r['last_video']=v
  r['samples'].append({'at_unix':time.time(),'video_status':v['status'],'stage':v.get('current_stage'),'progress':v.get('progress'),'gpu':get('/api/gpu')});save()
  if v['status']=='failed':raise RuntimeError(v.get('error_message') or 'Real generation failed')
  if v['status']=='completed':break
  time.sleep(10)
 else:raise TimeoutError('Observation deadline reached; remote job was NOT automatically cancelled or resubmitted')
 url=v.get('video_url');assert url,'Completed record lacks actual video URL'
 q=requests.get(url if url.startswith('http') else a.base.rstrip('/')+url,timeout=180);q.raise_for_status();video=path.with_suffix('.mp4');video.write_bytes(q.content)
 ff='ffmpeg'
 try:subprocess.run([ff,'-version'],capture_output=True,check=True)
 except FileNotFoundError:
  import imageio_ffmpeg
  ff=imageio_ffmpeg.get_ffmpeg_exe()
 decode=subprocess.run([ff,'-v','error','-i',str(video),'-f','null','-'],capture_output=True,text=True,timeout=300)
 if decode.returncode:raise RuntimeError('Full video decode failed: '+decode.stderr[:500])
 import imageio_ffmpeg
 reader=imageio_ffmpeg.read_frames(str(video));metadata=next(reader);frames=sum(1 for _ in reader);reader.close()
 r.update(status='RENDERED_NOT_VISUALLY_ACCEPTED',file=str(video),sha256=hashlib.sha256(q.content).hexdigest(),full_decode=True,decoded_frames=frames,media_metadata=metadata,visual_acceptance='REQUIRES_EVERY_FRAME_REVIEW',elapsed_observation_sec=time.monotonic()-began);save()
 print('Real video downloaded and decoded. Visual acceptance has NOT been granted.')
except SystemExit:raise
except Exception as e:
 r.update(status='FAILED_OR_BLOCKED',error=str(e));save();raise
