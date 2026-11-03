from cache_transport import download_verified_ranges
"""CPU-only provisioning of the exact diffusion artifact; NOT a complete renderer install.
Run in a private Kaggle CPU notebook. No GPU allocation, no music-model changes,
no removal of existing caches, references, outputs or unrelated environments.
"""
import hashlib,json,os,pathlib,shutil,subprocess,sys,time,urllib.request
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
 for cached in pathlib.Path('/kaggle/input').rglob(p.name):
  if verify(cached):
   shutil.copyfile(cached,p)
   print('Reused SHA-verified attached artifact; no Hugging Face download',flush=True)
   break
if not verify(p):
 if os.environ.get('ALLOW_MODEL_DOWNLOAD','1')!='1' and not os.environ.get('CACHE_SOURCE_URL'):raise RuntimeError('Verified attached cache missing; refusing unnecessary model re-download')
 part=p.with_suffix('.part')
 source_url=os.environ.get('CACHE_SOURCE_URL') or f'https://huggingface.co/{REPO}/resolve/{REVISION}/{FILE}'
 download_verified_ranges(source_url,part,SIZE,SHA)
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
# Create-only API: an existing private dataset causes a conflict, never a blind overwrite.
# Kaggle returns 403, not 404, for some nonexistent private dataset lookups;
# do not use that lookup to decide whether a creation is permitted.
result=api.dataset_create_new(str(root),public=False,quiet=False,dir_mode='skip')
if getattr(result,'error',None):raise RuntimeError('Private cache dataset creation failed')
print('VERIFIED_DIFFUSION_ARTIFACT_UPLOADED',OWNER+'/'+SLUG,flush=True)
print('No complete model installation, GPU inference, or cache-across-GPU-restart acceptance is claimed.',flush=True)
