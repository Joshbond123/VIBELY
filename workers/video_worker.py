"""Private, on-demand LTX-2.3 distilled Q4 worker. No runtime weight downloads.
A ready heartbeat requires pinned, SHA-256 verified mounted models and real Comfy nodes.
Output acknowledgement is separate from generation success; provider termination must
be verified independently by the app. No Android resources are accessed.
"""
import os,sys,json,time,pathlib,hashlib,threading,subprocess,urllib.request,urllib.error,uuid,base64,re,shutil,traceback
KAGGLE_API_TOKEN=os.environ['KAGGLE_API_TOKEN']
API_KEY=os.environ['WORKER_API_KEY']
REGISTRY_SECRET=os.environ['VIBELY_MODEL_REGISTRY_SECRET']
BACKEND=os.environ['VIBELY_BACKEND_URL']
SERVICE='ltx_2_3_distilled_gguf_q4'
OWNER='temilolo'
WORK=pathlib.Path('/kaggle/working');ROOT=pathlib.Path('/tmp/vibely_ltx');COMFY=ROOT/'ComfyUI'
ROOT.mkdir(exist_ok=True);WORK.mkdir(exist_ok=True)
STATE={'started_at':time.time(),'stage':'initializing','comfyui_ready':False,'last_error':None}
JOBS={};LOCK=threading.RLock();EXEC=threading.Lock();STOP=threading.Event();COMFY_PROC=None;TUNNEL_PROC=None
MODEL_SPECS=[{'repo': 'unsloth/LTX-2.3-GGUF', 'revision': '96e8ed4925ead3db9ff4d0084f165ef6a74f28d0', 'repo_path': 'distilled/ltx-2.3-22b-distilled-Q4_K_M.gguf', 'filename': 'ltx-2.3-22b-distilled-Q4_K_M.gguf', 'expected_bytes': 14326856736, 'sha256': '4e4459bee04199bf93187ba385729f6b7d8e874d754b72d26e751fe2066f4358', 'comfy_dirs': ['unet']}, {'repo': 'unsloth/LTX-2.3-GGUF', 'revision': '96e8ed4925ead3db9ff4d0084f165ef6a74f28d0', 'repo_path': 'vae/ltx-2.3-22b-distilled_video_vae.safetensors', 'filename': 'ltx-2.3-22b-distilled_video_vae.safetensors', 'expected_bytes': 1452256522, 'sha256': 'e68d6d8f8a42942ac9b862cc315beb3bc30805a8876c7ad63ba5bf7a2b8e168a', 'comfy_dirs': ['vae']}, {'repo': 'unsloth/LTX-2.3-GGUF', 'revision': '96e8ed4925ead3db9ff4d0084f165ef6a74f28d0', 'repo_path': 'vae/ltx-2.3-22b-distilled_audio_vae.safetensors', 'filename': 'ltx-2.3-22b-distilled_audio_vae.safetensors', 'expected_bytes': 364853140, 'sha256': '3cd6a6eb8cb28f5ecc12f1f3126952b2a3d2b0b42ad3270e63cefafafe0d9b57', 'comfy_dirs': ['checkpoints']}, {'repo': 'unsloth/LTX-2.3-GGUF', 'revision': '96e8ed4925ead3db9ff4d0084f165ef6a74f28d0', 'repo_path': 'text_encoders/ltx-2.3-22b-distilled_embeddings_connectors.safetensors', 'filename': 'ltx-2.3-22b-distilled_embeddings_connectors.safetensors', 'expected_bytes': 2312144712, 'sha256': 'c61cbb396e2a8175d8b2da51f0fdac885a4ccd22c9f64dafa5aa2c455dc8a507', 'comfy_dirs': ['text_encoders']}, {'repo': 'unsloth/gemma-3-12b-it-qat-GGUF', 'revision': '858acec7ec0541a46c39985c95d3b52d8f3ab183', 'repo_path': 'gemma-3-12b-it-qat-Q4_K_M.gguf', 'filename': 'gemma-3-12b-it-qat-Q4_K_M.gguf', 'expected_bytes': 7300778368, 'sha256': '5be55c72dac2e6ccaf8140bb6e793ad1c9d39f54fc4f3ccde54f2412e75cc830', 'comfy_dirs': ['text_encoders']}]
GGUF_REV='6ea2651e7df66d7585f6ffee804b20e92fb38b8a'

def log(s):
 print(time.strftime('%H:%M:%S'),s,flush=True)
 with (WORK/'vibely_ltx.log').open('a') as f:f.write(time.strftime('%H:%M:%S')+' '+str(s)+'\n')
def http(url,data=None,headers=None,timeout=20):
 req=urllib.request.Request(url,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json',**(headers or {})})
 with urllib.request.urlopen(req,timeout=timeout) as r:
  body=r.read()
  # Comfy /free, /history and /interrupt succeed with an empty HTTP 200.
  return json.loads(body) if body.strip() else {}
def backend(route,payload=None):return http(BACKEND+route,payload,{'X-Registry-Secret':REGISTRY_SECRET},10)
def command(args,cwd=None,timeout=600):
 subprocess.run(args,cwd=cwd,check=True,timeout=timeout)
def prepare():
 global COMFY_PROC
 STATE['stage']='verifying_mounted_models'
 staged=ROOT/'models';staged.mkdir(exist_ok=True)
 def stage_one(spec):
  matches=[p for p in pathlib.Path('/kaggle/input').rglob(spec['filename']) if p.stat().st_size==spec['expected_bytes']]
  if not matches:raise RuntimeError('Required account-owned cache asset missing: '+spec['filename']+'; no GPU-time weight download is allowed')
  dst=staged/spec['filename'];digest=hashlib.sha256()
  with matches[0].open('rb') as src,dst.open('wb') as out:
   for b in iter(lambda:src.read(16*1024*1024),b''):
    if STOP.is_set():raise RuntimeError('Model preparation cancelled')
    digest.update(b);out.write(b)
  if digest.hexdigest()!=spec['sha256']:dst.unlink();raise RuntimeError('Model integrity mismatch: '+spec['filename'])
 from concurrent.futures import ThreadPoolExecutor
 with ThreadPoolExecutor(max_workers=3) as copies:list(copies.map(stage_one,MODEL_SPECS))
 STATE['dataset_cached']=True;STATE['stage']='installing_pinned_comfyui'
 command(['git','clone','https://github.com/Comfy-Org/ComfyUI.git',str(COMFY)],timeout=180)
 command(['git','checkout','1332fabfcc507aa7c548cd5152071ed494c207e8'],cwd=COMFY)
 custom=COMFY/'custom_nodes'/'ComfyUI-GGUF'
 command(['git','clone','https://github.com/city96/ComfyUI-GGUF.git',str(custom)],timeout=180)
 command(['git','checkout',GGUF_REV],cwd=custom)
 command([sys.executable,'-m','pip','install','-q','-r',str(COMFY/'requirements.txt'),'-r',str(custom/'requirements.txt'),'fastapi','uvicorn','websocket-client'],timeout=600)
 import torch
 if not torch.cuda.is_available():raise RuntimeError('Kaggle did not allocate a working CUDA GPU')
 STATE['gpu_name']=', '.join(torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count()))
 log('Allocated CUDA devices: '+STATE['gpu_name'])
 # Explicitly place text/VAE on the second device when real T4x2 hardware exists.
 if torch.cuda.device_count()>1:
  file=COMFY/'comfy'/'model_management.py';s=file.read_text()
  for name in ('text_encoder_device','vae_device'):
   marker='def '+name+'():\n'
   if marker not in s:raise RuntimeError('Pinned device-placement interface changed')
   s=s.replace(marker,marker+"    return torch.device('cuda:1')\n",1)
  file.write_text(s)
 for spec in MODEL_SPECS:
  for directory in spec['comfy_dirs']:
   d=COMFY/'models'/directory;d.mkdir(exist_ok=True,parents=True);(d/spec['filename']).symlink_to(staged/spec['filename'])
 STATE['stage']='starting_comfyui'
 out=(WORK/'comfyui_ltx.log').open('a')
 COMFY_PROC=subprocess.Popen([sys.executable,'main.py','--listen','127.0.0.1','--port','8188','--disable-auto-launch','--lowvram','--fp16-unet','--fp32-vae','--reserve-vram','2.5','--cache-none','--disable-smart-memory'],cwd=COMFY,stdout=out,stderr=subprocess.STDOUT)
 required=['UnetLoaderGGUF','DualCLIPLoaderGGUF','LTXVImgToVideoInplace','LTXVEmptyLatentAudio','LTXVAudioVAELoader','LTXVConcatAVLatent','LTXVSeparateAVLatent','LTXVConditioning','ManualSigmas','SamplerCustomAdvanced','SaveVideo']
 end=time.time()+360
 while time.time()<end:
  if COMFY_PROC.poll() is not None:raise RuntimeError('ComfyUI exited during initialization; inspect private log')
  try:
   info=http('http://127.0.0.1:8188/object_info')
   missing=[x for x in required if x not in info]
   if missing:raise RuntimeError('Missing required Comfy nodes: '+','.join(missing))
   if 'ltxv' not in info['DualCLIPLoaderGGUF']['input']['required']['type'][0]:raise RuntimeError('GGUF loader does not support LTX text conditioning')
   STATE.update(stage='ready',comfyui_ready=True);log('Pinned real LTX node graph ready');return
  except urllib.error.URLError:time.sleep(2)
 raise RuntimeError('ComfyUI startup deadline exceeded')

def workflow(job, image):
 frames=int(job['frames']);width=int(job.get('width',736));height=int(job.get('height',1280));native=((frames-1+7)//8)*8+1
 if not 1<=frames<=121 or width%32 or height%32 or not 256<=width<=1280 or not 256<=height<=1536:raise ValueError('Invalid LTX geometry or segment length')
 files={s['filename']:s['filename'] for s in MODEL_SPECS}
 dit=next(x for x in files if x.endswith('.gguf') and 'ltx-' in x);gemma=next(x for x in files if 'gemma' in x)
 video=next(x for x in files if 'video_vae' in x);audio=next(x for x in files if 'audio_vae' in x);connect=next(x for x in files if 'connectors' in x)
 w={}
 def n(i,t,**v):w[str(i)]={'class_type':t,'inputs':v}
 n(1,'UnetLoaderGGUF',unet_name=dit)
 n(2,'DualCLIPLoaderGGUF',clip_name1=gemma,clip_name2=connect,type='ltxv')
 n(3,'VAELoader',vae_name=video);n(4,'LTXVAudioVAELoader',ckpt_name=audio)
 n(5,'CLIPTextEncode',clip=['2',0],text=job['prompt']);n(6,'CLIPTextEncode',clip=['2',0],text='')
 n(7,'LTXVConditioning',positive=['5',0],negative=['6',0],frame_rate=24.0)
 n(8,'EmptyLTXVLatentVideo',width=width,height=height,length=native,batch_size=1)
 n(9,'LoadImage',image=image)
 n(10,'ImageScale',image=['9',0],upscale_method='lanczos',width=width,height=height,crop='center')
 n(11,'LTXVPreprocess',image=['10',0],img_compression=18)
 n(12,'LTXVImgToVideoInplace',vae=['3',0],image=['11',0],latent=['8',0],strength=1.0,bypass=False)
 n(13,'LTXVEmptyLatentAudio',audio_vae=['4',0],frames_number=native,frame_rate=24,batch_size=1)
 n(14,'LTXVConcatAVLatent',video_latent=['12',0],audio_latent=['13',0])
 n(15,'RandomNoise',noise_seed=int(job.get('seed',42)))
 n(16,'CFGGuider',model=['1',0],positive=['7',0],negative=['7',1],cfg=1.0)
 n(17,'KSamplerSelect',sampler_name='euler_ancestral_cfg_pp')
 n(18,'ManualSigmas',sigmas='1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0')
 n(19,'SamplerCustomAdvanced',noise=['15',0],guider=['16',0],sampler=['17',0],sigmas=['18',0],latent_image=['14',0])
 n(20,'LTXVSeparateAVLatent',av_latent=['19',0])
 n(21,'VAEDecodeTiled',samples=['20',0],vae=['3',0],tile_size=512,overlap=64,temporal_size=64,temporal_overlap=8)
 n(22,'LTXVAudioVAEDecode',samples=['20',1],audio_vae=['4',0])
 n(23,'CreateVideo',images=['21',0],audio=['22',0],fps=24.0)
 n(24,'SaveVideo',video=['23',0],filename_prefix='ltx/'+job['id'],format='mp4',codec='h264')
 return w

def run_job(jid,payload):
 with EXEC:
  job=JOBS[jid]
  if job.get('cancelled'):return
  try:
   job.update(status='running',stage='encoding_reference_and_text',started_at=time.time())
   image=COMFY/'input'/(jid+'.png');image.parent.mkdir(exist_ok=True)
   data=base64.b64decode(payload['reference_base64'],validate=True)
   if len(data)>20*1024*1024:raise ValueError('Reference too large')
   image.write_bytes(data)
   # Do not retain prior segment models/latents across sequential jobs.
   # Memory policy only: native resolution, frames, sigmas and steps are unchanged.
   http('http://127.0.0.1:8188/free',{'unload_models':True,'free_memory':True})
   http('http://127.0.0.1:8188/history',{'clear':True})
   w=workflow(job,image.name);client=str(uuid.uuid4());result=http('http://127.0.0.1:8188/prompt',{'prompt':w,'client_id':client})
   pid=result.get('prompt_id')
   if not pid:raise RuntimeError('Comfy rejected LTX graph: '+json.dumps(result.get('node_errors',{}))[:2000])
   job['prompt_id']=pid
   # Read measured sampling progress from Comfy websocket, never an invented ETA.
   def progress():
    try:
     import websocket
     ws=websocket.create_connection('ws://127.0.0.1:8188/ws?clientId='+client,timeout=10)
     while job['status']=='running':
      try:m=json.loads(ws.recv())
      except (ValueError,TypeError,websocket.WebSocketTimeoutException):continue
      d=m.get('data',{})
      if m.get('type')=='progress' and str(d.get('node','19'))=='19':job.update(stage='sampling',sampling_step=d.get('value'),sampling_steps=d.get('max'))
     ws.close()
    except Exception:pass
   threading.Thread(target=progress,daemon=True).start()
   end=time.time()+2400
   while time.time()<end:
    if job.get('cancelled'):raise RuntimeError('Generation cancelled')
    h=http('http://127.0.0.1:8188/history/'+pid).get(pid)
    if h:
     if h.get('status',{}).get('status_str')=='error':raise RuntimeError('Comfy execution failed: '+json.dumps(h.get('status',{}).get('messages',[]))[-2000:])
     paths=[COMFY/'output'/x.get('subfolder','')/x['filename'] for output in h.get('outputs',{}).values() for k in ('images','gifs','videos') for x in output.get(k,[]) if str(x.get('filename','')).endswith('.mp4')]
     if paths:
      result=paths[0];command(['ffmpeg','-v','error','-i',str(result),'-f','null','-'],timeout=120)
      probe=subprocess.run(['ffprobe','-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','csv=p=0',str(result)],capture_output=True,text=True,check=True)
      if int(probe.stdout.strip())<job['frames']:raise RuntimeError('Generated clip is too short; padding/looping is forbidden')
      job.update(status='completed',stage='awaiting_durable_output_receipt',output_path=str(result),bytes=result.stat().st_size,sha256=hashlib.sha256(result.read_bytes()).hexdigest(),completed_at=time.time());return
    if COMFY_PROC.poll() is not None:raise RuntimeError('ComfyUI exited')
    time.sleep(2)
   raise TimeoutError('LTX segment exceeded its bounded inference deadline')
  except Exception as e:
   try:http('http://127.0.0.1:8188/interrupt',{})
   except Exception:pass
   job.update(status='failed',stage='failed',error=str(e),completed_at=time.time());log('Segment failed: '+str(e))

def heartbeat():
 while not STOP.is_set():
  try:
   if STATE.get('endpoint_url'):backend('/api/models/register',{'service':SERVICE,'username':OWNER,'model_name':'LTX-2.3 Distilled GGUF Q4_K_M','endpoint_url':STATE['endpoint_url'],'api_key':API_KEY,'comfyui_ready':STATE['comfyui_ready'],'dataset_cached':STATE.get('dataset_cached',False),'storage_sources':{'model_dataset':'temilolo/ltx-23-distilled-q4-cache'},'gpu_name':STATE.get('gpu_name'),'worker_version':'lifecycle-v3','worker_started_at':STATE['started_at']})
  except Exception as e:log('Registry heartbeat failed: '+type(e).__name__+' '+str(getattr(e,'code','')))
  STOP.wait(10)
def tunnel():
 global TUNNEL_PROC
 try:
  binary=ROOT/'cloudflared';command(['curl','-fsSL','https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64','-o',str(binary)],timeout=90);binary.chmod(0o755)
  while not STOP.is_set():
   file=WORK/'cloudflared_ltx.log';f=file.open('w');TUNNEL_PROC=subprocess.Popen([str(binary),'tunnel','--protocol','http2','--url','http://127.0.0.1:8000','--no-autoupdate'],stdout=f,stderr=subprocess.STDOUT)
   while TUNNEL_PROC.poll() is None and not STOP.wait(1):
    m=re.search(r'https://[a-z0-9-]+\.trycloudflare\.com',file.read_text())
    if m and STATE.get('endpoint_url')!=m.group(0):
     STATE['endpoint_url']=m.group(0);log('Quick tunnel endpoint discovered')
    if not m and int(time.time()-STATE['started_at'])%30==0:
     excerpt=re.sub(r'https?://[^\s]+','[URL]',file.read_text()[-1200:])
     log('Tunnel initialization diagnostic: '+excerpt)
   if not STOP.is_set():log('Tunnel process exited; retrying');STOP.wait(3)
   f.close()
 except Exception as e:STATE['last_error']=str(e);log('Tunnel fatal error: '+type(e).__name__);STOP.set()
def main():
 global COMFY_PROC
 command([sys.executable,'-m','pip','install','-q','fastapi','uvicorn'],timeout=180)
 from fastapi import FastAPI,Header,HTTPException
 from fastapi.responses import FileResponse
 import uvicorn
 app=FastAPI()
 def auth(value):
  import hmac
  if not hmac.compare_digest(value,'Bearer '+API_KEY):raise HTTPException(401,'Unauthorized')
 @app.get('/health')
 def health():return {'service':SERVICE,'comfyui_ready':STATE['comfyui_ready'],'stage':STATE['stage'],'worker_version':'lifecycle-v3'}
 @app.post('/v1/video/jobs')
 def submit(p:dict,authorization:str=Header(default='')):
  auth(authorization)
  if not STATE['comfyui_ready']:raise HTTPException(503,'LTX is not ready')
  jid=p.get('job_id','')
  if not re.fullmatch('[A-Za-z0-9_-]{1,100}',jid):raise HTTPException(400,'A safe idempotent job_id is required')
  if not isinstance(p.get('prompt'),str) or not p.get('reference_base64'):raise HTTPException(400,'Prompt and actual reference are required')
  fingerprint=hashlib.sha256(json.dumps(p,sort_keys=True).encode()).hexdigest()
  with LOCK:
   if jid in JOBS:
    if JOBS[jid]['fingerprint']!=fingerprint:raise HTTPException(409,'Job identifier reused with a different request')
   else:
    JOBS[jid]={'id':jid,'frames':int(p['frames']),'width':int(p.get('width',736)),'height':int(p.get('height',1280)),'prompt':p['prompt'],'seed':int(p.get('seed',42)),'fingerprint':fingerprint,'status':'queued','stage':'queued','created_at':time.time()}
    threading.Thread(target=run_job,args=(jid,p),daemon=True).start()
  return {'job_id':jid,'status':JOBS[jid]['status']}
 @app.get('/v1/video/jobs/{jid}')
 def status(jid:str,authorization:str=Header(default='')):
  auth(authorization)
  if jid not in JOBS:raise HTTPException(404,'Unknown job; no automatic replacement is generated')
  return {k:v for k,v in JOBS[jid].items() if k not in ('output_path','prompt','fingerprint')}
 @app.get('/v1/video/jobs/{jid}/video')
 def video(jid:str,authorization:str=Header(default='')):
  auth(authorization);j=JOBS.get(jid)
  if not j or j['status']!='completed':raise HTTPException(404,'Output not completed')
  return FileResponse(j['output_path'],media_type='video/mp4')
 @app.post('/v1/video/jobs/{jid}/acknowledge')
 def ack(jid:str,p:dict,authorization:str=Header(default='')):
  auth(authorization);j=JOBS.get(jid)
  if not j or j['status']!='completed':raise HTTPException(409,'No completed output')
  if p.get('sha256')!=j['sha256'] or p.get('bytes')!=j['bytes'] or p.get('playable') is not True:raise HTTPException(400,'Exact persisted playable output receipt required')
  j['persisted_receipt']=p;return {'ok':True}
 @app.post('/v1/video/jobs/{jid}/cancel')
 def cancel(jid:str,authorization:str=Header(default='')):
  auth(authorization);j=JOBS.get(jid)
  if j and j['status'] in ('queued','running'):
   j['cancelled']=True
   if j['status']=='running':
    try:http('http://127.0.0.1:8188/interrupt',{})
    except Exception:pass
   else:j.update(status='failed',error='Cancelled while queued')
  return {'ok':True}
 @app.post('/v1/lifecycle/shutdown')
 def shutdown(p:dict,authorization:str=Header(default='')):
  auth(authorization)
  if any(j['status'] in ('queued','running') or j['status']=='completed' and not j.get('persisted_receipt') for j in JOBS.values()):raise HTTPException(409,'Active work or unacknowledged real output remains')
  STOP.set();return {'ok':True,'state':'STOPPING'}
 @app.get('/v1/telemetry')
 def telemetry(authorization:str=Header(default='')):
  auth(authorization)
  r=subprocess.run(['nvidia-smi','--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True,check=True,timeout=8)
  g=[]
  for line in r.stdout.strip().splitlines():
   a=[x.strip() for x in line.split(',')]
   def number(s):
    try:return float(s)
    except ValueError:return None
   g.append(dict(zip(['index','name','utilization_percent','memory_used_mib','memory_total_mib','temperature_c'],[number(a[0]),a[1],*[number(x) for x in a[2:]]])))
  running=[j for j in JOBS.values() if j['status'] in ('queued','running')]
  return {'measured_at':time.time(),'gpus':g,'active_jobs':len(running),'current_tasks':[j['stage'] for j in running],'session_started_at':STATE['started_at']}
 threading.Thread(target=lambda:uvicorn.run(app,host='0.0.0.0',port=8000,log_level='warning'),daemon=True).start()
 threading.Thread(target=tunnel,daemon=True).start();threading.Thread(target=heartbeat,daemon=True).start()
 def watchdog():
  while not STOP.wait(5):
   elapsed=time.time()-STATE['started_at']
   if not STATE['comfyui_ready'] and elapsed>120:
    try:
     leases=backend('/api/gpu/leases?service_id='+SERVICE)
     if leases.get('ok') and leases.get('pending')==0:
      log('No pending generation lease during startup; stopping unused GPU session')
      if COMFY_PROC and COMFY_PROC.poll() is None:COMFY_PROC.kill()
      os._exit(0)
    except Exception:pass
   if not STATE['comfyui_ready'] and elapsed>18*60 or elapsed>2*3600:
    log('Hard startup/runtime deadline reached; terminating batch session')
    if COMFY_PROC and COMFY_PROC.poll() is None:COMFY_PROC.kill()
    os._exit(1)
 threading.Thread(target=watchdog,daemon=True).start()
 try:prepare()
 except Exception as e:
  STATE.update(stage='error',last_error=str(e));log(traceback.format_exc())
  try:backend('/api/gpu/startup-failed',{'service_id':SERVICE,'attempt_started_at':STATE['started_at'],'error':str(e)})
  except Exception:pass
  STOP.set()
 idle=time.time()
 while not STOP.wait(3):
  if COMFY_PROC is not None and COMFY_PROC.poll() is not None:break
  busy=any(j['status'] in ('running','queued') or j['status']=='completed' and not j.get('persisted_receipt') for j in JOBS.values())
  if busy:
   idle=time.time()
   # Never retain an unclaimed output indefinitely after an interrupted app.
   if any(j['status']=='completed' and not j.get('persisted_receipt') and time.time()-j['completed_at']>10*60 for j in JOBS.values()):break
  elif time.time()-idle>10:
   try:
    if backend('/api/gpu/leases?service_id='+SERVICE).get('pending')==0:break
   except Exception:pass
   if time.time()-idle>15*60:break
 STATE.update(stage='shutting_down',comfyui_ready=False);STOP.set()
 for proc in (COMFY_PROC,TUNNEL_PROC):
  if proc is not None and proc.poll() is None:
   proc.terminate()
   try:proc.wait(timeout=20)
   except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=10)
 try:backend('/api/gpu/stopped',{'service_id':SERVICE,'worker_started_at':STATE['started_at']})
 except Exception:pass
 log('Worker process exits now; only provider session status proves GPU OFF')
if __name__=='__main__':main()
