"""One-shot Kaggle video hardware audit. No models or credentials are printed."""
import json,os,pathlib,platform,subprocess,time

def command(args):
 p=subprocess.run(args,capture_output=True,text=True,timeout=45)
 return {'exit_code':p.returncode,'stdout':p.stdout.strip(),'stderr':p.stderr.strip()}
r={'measured_at_unix':time.time(),'platform':platform.platform(),'cpu_count':os.cpu_count(),
 'nvidia_smi':command(['nvidia-smi','--query-gpu=index,name,uuid,memory.total,memory.free,compute_cap,driver_version,power.limit','--format=csv,noheader,nounits']),
 'gpu_topology':command(['nvidia-smi','topo','-m']),
 'memory':pathlib.Path('/proc/meminfo').read_text(),
 'disk':command(['df','-h','/kaggle/working','/tmp','/dev/shm'])}
try:
 import torch
 r['torch']={'version':torch.__version__,'cuda_version':torch.version.cuda,'gpu_count':torch.cuda.device_count(),
 'gpus':[{'index':i,'name':torch.cuda.get_device_name(i),'compute_capability':torch.cuda.get_device_capability(i),'total_memory_bytes':torch.cuda.get_device_properties(i).total_memory,'free_total_bytes':torch.cuda.mem_get_info(i),'bf16_supported':torch.cuda.is_bf16_supported(including_emulation=False) if i==torch.cuda.current_device() else None} for i in range(torch.cuda.device_count())],
 'peer_access':{f'{i}->{j}':torch.cuda.can_device_access_peer(i,j) for i in range(torch.cuda.device_count()) for j in range(torch.cuda.device_count()) if i!=j}}
except Exception as e:r['torch_error']=type(e).__name__+': '+str(e)
pathlib.Path('/kaggle/working/vibely-hardware.json').write_text(json.dumps(r,indent=2))
print(json.dumps(r,indent=2))
