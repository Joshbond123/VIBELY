"""Fresh-session, offline verification of the persisted diffusion checkpoint only."""
import os,json,pathlib,hashlib,subprocess
NAME='Wan-Animate-2-14B-TURBO-Q5_K_M.gguf'
SIZE=12741204960
SHA='c43e655ea8e76420630526291c75359c7fd4114efb592b07f67c0d99ab51296f'
paths=list(pathlib.Path('/kaggle/input').rglob(NAME))
if len(paths)!=1:raise RuntimeError('Expected exactly one attached persistent diffusion artifact')
p=paths[0]
if p.stat().st_size!=SIZE:raise RuntimeError('Persistent artifact size mismatch')
digest=hashlib.sha256()
with p.open('rb') as f:
 for data in iter(lambda:f.read(8*1024*1024),b''):digest.update(data)
if digest.hexdigest()!=SHA:raise RuntimeError('Persistent artifact SHA mismatch')
proof={'scope':'diffusion checkpoint only, not complete renderer','attached_persistent_dataset':True,'size':SIZE,'sha256':SHA,'checksum_passed':True,'huggingface_download_performed':False,'gpu_enabled':False,'inference_tested':False}
pathlib.Path('/kaggle/working/persistent-cache-verification.json').write_text(json.dumps(proof,indent=2));print(json.dumps(proof),flush=True)
