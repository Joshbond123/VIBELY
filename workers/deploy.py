"""Deploy repository worker sources to PRIVATE Kaggle kernels from GitHub Actions.
Secrets are injected at deployment time; never commit rendered worker files.
"""
import ast, json, os, pathlib, subprocess, tempfile, sys
SPECS={
 'video':('joshbond123','vibely-minimax-h3-ref2va-server',['joshbond123/minimax-h3-ref2va-cache','joshbond123/scarlett-monroe-character-refs'],'KAGGLE_JOSHBOND_TOKEN','MINIMAX_H3_API_KEY'),
 'music':('happink','vibely-minimax-music-3-q4-0-gguf-server',['happink/minimax-music-3-q4-0-gguf-cache'],'KAGGLE_HAPPINK_TOKEN','MINIMAX_MUSIC3_API_KEY')}
for kind in ([sys.argv[1]] if len(sys.argv)>1 and sys.argv[1]!='all' else SPECS):
 user,slug,datasets,token_var,api_var=SPECS[kind]
 source=pathlib.Path(__file__).with_name(kind+'_worker.py').read_text()
 values={'KAGGLE_API_TOKEN':os.environ[token_var],'WORKER_API_KEY':os.environ[api_var],'HF_TOKEN':os.environ['HF_TOKEN'],'VIBELY_MODEL_REGISTRY_SECRET':os.environ['VIBELY_MODEL_REGISTRY_SECRET'],'VIBELY_BACKEND_URL':'https://aivideo.aivideo.blitz.cloud'}
 # Replace only explicit deployment placeholders, not arbitrary source strings.
 for key,value in values.items(): source=source.replace('os.environ['+repr(key)+']',repr(value))
 compile(source,slug,'exec')
 with tempfile.TemporaryDirectory() as temp:
  p=pathlib.Path(temp);(p/'server.py').write_text(source)
  (p/'kernel-metadata.json').write_text(json.dumps({'id':user+'/'+slug,'title':'VIBELY '+kind+' GPU worker','code_file':'server.py','language':'python','kernel_type':'script','is_private':True,'enable_gpu':True,'enable_internet':True,'enable_tpu':False,'dataset_sources':datasets,'competition_sources':[],'kernel_sources':[],'model_sources':[]}))
  env={**os.environ,'KAGGLE_USERNAME':user,'KAGGLE_KEY':values['KAGGLE_API_TOKEN'],'KAGGLE_API_TOKEN':values['KAGGLE_API_TOKEN']}
  result=subprocess.run(['kaggle','kernels','push','-p',temp],env=env,capture_output=True,text=True)
  # Do not echo CLI output: a vendor exception can contain credentials.
  if result.returncode: raise RuntimeError('Kaggle deployment failed for '+kind+' (exit '+str(result.returncode)+')')
  print('Deployed private '+kind+' worker from GitHub source',flush=True)
