"""CPU-only provisioning of the exact diffusion artifact; NOT a complete renderer install.
Run in a private Kaggle CPU notebook. No GPU allocation, no music-model changes,
no removal of existing caches, references, outputs or unrelated environments.
"""
import hashlib,json,os,pathlib,subprocess,sys,time,urllib.request
OWNER=os.environ['CACHE_OWNER']
TOKEN=os.environ['KAGGLE_API_TOKEN']
REPO='realrebelai/Wan-Animate-2_GGUFs'
REVISION='46b287218ffe4223cfedba0c06e36db356d34ff9'
FILE='Distilled/Wan-Animate-2-14B-TURBO-Q5_K_M.gguf'
SIZE=12741204960
SHA='c43e655ea8e76420630526291c75359c7fd4114efb592b07f67c0d99ab51296f'
SLUG='vibely-wan-animate2-distilled-q5-cache'
root=pathlib.Path('/kaggle/working/vibely-wan-cache-provision');root.mkdir(parents=True,exist_ok=True)
p=root/pathlib.Path(FILE).name

def verify(path):
 if not path.is_file() or path.stat().st_size!=SIZE:return False
 digest=hashlib.sha256()
 with path.open('rb') as f:
  for data in iter(lambda:f.read(8*1024*1024),b''):digest.update(data)
 return digest.hexdigest()==SHA

if not verify(p):
 part=p.with_suffix('.part');digest=hashlib.sha256();n=0
 with urllib.request.urlopen(f'https://huggingface.co/{REPO}/resolve/{REVISION}/{FILE}',timeout=120) as r,part.open('wb') as out:
  while True:
   data=r.read(8*1024*1024)
   if not data:break
   n+=len(data)
   if n>SIZE:raise RuntimeError('Artifact larger than pinned size')
   out.write(data);digest.update(data)
  out.flush();os.fsync(out.fileno())
 if n!=SIZE or digest.hexdigest()!=SHA:raise RuntimeError('Artifact verification failed; not publishing')
 part.replace(p)
manifest={'scope':'diffusion artifact only; encoder/VAE/dependencies/runtime NOT installed','repository':REPO,'revision':REVISION,'file':FILE,'bytes':SIZE,'sha256':SHA,'verified':True}
(root/'artifact-lock.json').write_text(json.dumps(manifest,indent=2))
(root/'dataset-metadata.json').write_text(json.dumps({'title':'VIBELY Wan Animate 2 distilled Q5 cache','id':OWNER+'/'+SLUG,'licenses':[{'name':'apache-2.0'}]}))
os.environ.update(KAGGLE_USERNAME=OWNER,KAGGLE_API_TOKEN=TOKEN,KAGGLE_KEY=TOKEN)
try:from kaggle.api.kaggle_api_extended import KaggleApi
except ImportError:
 subprocess.run([sys.executable,'-m','pip','install','--quiet','kaggle==2.2.5','six'],check=True)
 from kaggle.api.kaggle_api_extended import KaggleApi
api=KaggleApi();api.authenticate()
# Never mutate/delete a prior cache. Existing names require explicit review.
try:
 existing=api.dataset_list_files(OWNER+'/'+SLUG)
except Exception as e:
 if '404' not in str(e):raise
else:
 raise RuntimeError('Cache dataset already exists: verify/reuse it rather than blindly creating a version')
result=api.dataset_create_new(str(root),public=False,quiet=False,dir_mode='skip')
if getattr(result,'error',None):raise RuntimeError('Private cache dataset creation failed')
print('VERIFIED_DIFFUSION_ARTIFACT_UPLOADED',OWNER+'/'+SLUG,flush=True)
print('No complete model installation, GPU inference, or cache-across-GPU-restart acceptance is claimed.',flush=True)
