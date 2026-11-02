"""Deploy repository worker sources to PRIVATE Kaggle kernels from GitHub Actions.
Secrets are injected at deployment time; never commit rendered worker files.
"""
import ast, json, os, pathlib, subprocess, tempfile, sys, time, urllib.request, urllib.error
SPECS={
 'video':('joshbond123','vibely-minimax-h3-ref2va-server',['joshbond123/minimax-h3-ref2va-cache','joshbond123/scarlett-monroe-character-refs'],'KAGGLE_JOSHBOND_TOKEN','MINIMAX_H3_API_KEY'),
 'music':('happink','vibely-music-gpu-worker',['happink/minimax-music-3-q4-0-gguf-cache'],'KAGGLE_HAPPINK_TOKEN','MINIMAX_MUSIC3_API_KEY')}
for kind in ([sys.argv[1]] if len(sys.argv)>1 and sys.argv[1]!='all' else SPECS):
 user,slug,datasets,token_var,api_var=SPECS[kind]
 source=pathlib.Path(__file__).with_name(kind+'_worker.py').read_text()
 values={'KAGGLE_API_TOKEN':os.environ[token_var],'WORKER_API_KEY':os.environ[api_var],'HF_TOKEN':os.environ['HF_TOKEN'],'VIBELY_MODEL_REGISTRY_SECRET':os.environ['VIBELY_MODEL_REGISTRY_SECRET'],'VIBELY_BACKEND_URL':'https://aivideo.aivideo.blitz.cloud'}
 # Replace only explicit deployment placeholders, not arbitrary source strings.
 for key,value in values.items(): source=source.replace('os.environ['+repr(key)+']',repr(value))
 compile(source,slug,'exec')
 with tempfile.TemporaryDirectory() as temp:
  p=pathlib.Path(temp);(p/'server.py').write_text(source)
  metadata={'id':user+'/'+slug,'title':('VIBELY MiniMax H3 Ref2VA Server' if kind=='video' else 'VIBELY music GPU worker'),'code_file':'server.py','language':'python','kernel_type':'script','is_private':'true','enable_gpu':'true','enable_internet':'true','enable_tpu':'false','dataset_sources':datasets,'competition_sources':[],'kernel_sources':[],'model_sources':[]}
  # Resolve numeric identity before saving, so changing a title cannot fork/rename another worker.
  for candidate in [slug,'vibely-'+kind+'-gpu-worker']:
   try:
    req=urllib.request.Request('https://www.kaggle.com/api/v1/kernels/pull/'+user+'/'+candidate,headers={'Authorization':'Bearer '+values['KAGGLE_API_TOKEN']})
    existing=json.load(urllib.request.urlopen(req,timeout=20)).get('metadata',{})
    if existing.get('id'):metadata['id_no']=existing['id'];break
   except urllib.error.HTTPError as e:
    if e.code not in (403,404):raise
  (p/'kernel-metadata.json').write_text(json.dumps(metadata))
  # The Kaggle CLI prints API errors but may return exit code zero. Never use
  # process success as evidence that a notebook version was actually saved/run.
  os.environ.update({'KAGGLE_USERNAME':user,'KAGGLE_KEY':values['KAGGLE_API_TOKEN'],'KAGGLE_API_TOKEN':values['KAGGLE_API_TOKEN']})
  from kaggle.api.kaggle_api_extended import KaggleApi
  api=KaggleApi();api.authenticate()
  for attempt in range(5):
   try:
    result=api.kernels_push(temp)
    if result is None:raise RuntimeError('Kaggle SaveKernel returned no result')
    error=getattr(result,'error',None)
    if error:raise RuntimeError('Kaggle rejected worker startup: '+str(error))
    version=getattr(result,'version_number',None) or getattr(result,'versionNumber',None)
    if not version:raise RuntimeError('Kaggle SaveKernel did not return a saved version number')
    if getattr(result,'invalid_dataset_sources',None) or getattr(result,'invalidDatasetSources',None):raise RuntimeError('Required private model dataset unavailable to this account')
    break
   except Exception as e:
    message=str(e)
    for value in values.values():message=message.replace(value,'[REDACTED]')
    if attempt<4 and ('409' in message or 'Conflict' in message):time.sleep(30);continue
    raise RuntimeError(message) from None
  # Verify the saved source rather than reporting a successful render or ready GPU.
  req=urllib.request.Request('https://www.kaggle.com/api/v1/kernels/pull/'+user+'/'+slug,headers={'Authorization':'Bearer '+values['KAGGLE_API_TOKEN']})
  saved=json.load(urllib.request.urlopen(req,timeout=30))
  if saved.get('blob',{}).get('source')!=source:raise RuntimeError('Kaggle source read-back did not match this GitHub worker revision')
  print('Verified private '+kind+' worker source version '+str(version)+'; runtime readiness still requires authenticated worker heartbeat',flush=True)
