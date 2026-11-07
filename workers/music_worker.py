
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid

KAGGLE_USERNAME = "joshbond123"
KAGGLE_API_TOKEN = os.environ['KAGGLE_API_TOKEN']
HF_TOKEN = os.environ['HF_TOKEN']
API_KEY = os.environ['WORKER_API_KEY']
REGISTRY_SECRET = os.environ['VIBELY_MODEL_REGISTRY_SECRET']
VIBELY_BACKEND_URL = os.environ['VIBELY_BACKEND_URL']
CACHE_DATASET_SLUG = "joshbond123/minimax-music-3-q4-0-gguf-cache"
CACHE_DATASET_TITLE = "MiniMax Music 3 Q4_0 GGUF Persistent Cache"

MODEL_SPECS = [{'filename': 'minimax_music3_dit_Q4_0.gguf', 'repo': 'molbal/Minimax-Music3-GGUF', 'repo_path': 'minimax_music3_dit_Q4_0.gguf', 'expected_bytes': 1490267392, 'comfy_dirs': ['unet', 'diffusion_models'], 'revision': 'd6ab7b871d22a050aa734e8669f25427fbdae153', 'sha256': '808010c9e35f5fe1996fda2469d56969d2977517e820ca7a3c0a6b47b5042062'}, {'filename': 'minimax_music3_text_encoder_pruned_Q4_0.gguf', 'repo': 'molbal/Minimax-Music3-GGUF', 'repo_path': 'minimax_music3_text_encoder_pruned_Q4_0.gguf', 'expected_bytes': 5774253216, 'comfy_dirs': ['clip', 'text_encoders'], 'revision': 'd6ab7b871d22a050aa734e8669f25427fbdae153', 'sha256': '5aca4e32e105ac2aeabf4c1014b7a484cb5effe4c50a00283279fd0f910f193b'}, {'filename': 'minimax_music3_dav.safetensors', 'repo': 'Comfy-Org/MiniMax-Music-3', 'repo_path': 'vae/minimax_music3_dav.safetensors', 'expected_bytes': 216696128, 'comfy_dirs': ['vae'], 'revision': '9e364ccd290a401561091fb441ed19cd7de92550', 'sha256': '2a32155b769be01445fcc2a8663b910fc9e1751e18dc1c3ec528064512d9ef0c'}]

WORK_ROOT = "/kaggle/working"
TMP_ROOT = "/kaggle/tmp" if os.path.isdir("/kaggle/tmp") else "/tmp/vibely_store"
PERSIST_MODELS_DIR = os.path.join(WORK_ROOT, "persistent_models_music3")
COMFY_DIR = os.path.join(TMP_ROOT, "ComfyUI")
JOBS_DIR = os.path.join(WORK_ROOT, "music_jobs")
os.makedirs(PERSIST_MODELS_DIR, exist_ok=True)
os.makedirs(JOBS_DIR, exist_ok=True)
os.makedirs(TMP_ROOT, exist_ok=True)

STATE = {
    "stage": "booting",
    "comfyui_ready": False,
    "storage_sources": {},
    "dataset_cached": False,
    "tunnel_url": "",
    "gpu_name": "",
    "started_at": time.time(),
    "last_error": "",
}
JOBS = {}
JOBS_LOCK = threading.Lock()
SHUTDOWN_REQUESTED=threading.Event()
LAST_ACTIVITY_AT=time.time()
MUSIC_EXECUTION_LOCK = threading.Lock()

def log(msg: str):
    ts = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    line = f"[{ts}] [MUSIC3] {msg}"
    print(line, flush=True)
    try:
        with open(os.path.join(WORK_ROOT, "vibely_music3.log"), "a") as lf:
            lf.write(line + "\n")
    except Exception:
        pass

def healthy_file(path: str, expected_bytes: int) -> bool:
    try:
        if not os.path.exists(path):
            return False
        sz = os.path.getsize(path)
        return sz >= int(expected_bytes * 0.97)
    except Exception:
        return False

def scan_kaggle_inputs(filename: str, expected_bytes: int) -> str:
    if not os.path.isdir("/kaggle/input"):
        return ""
    for root, _, files in os.walk("/kaggle/input"):
        if filename in files:
            p = os.path.join(root, filename)
            if healthy_file(p, expected_bytes):
                return p
    return ""

def check_dataset_exists_remote() -> bool:
    try:
        req = urllib.request.Request(
            f"https://www.kaggle.com/api/v1/datasets/view/{CACHE_DATASET_SLUG}",
            headers={"Authorization": f"Bearer {KAGGLE_API_TOKEN}"},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read().decode())
            total = int(d.get("totalBytesNullable") or d.get("totalBytes") or 0)
            return total > 7_000_000_000
    except Exception:
        return False

def try_download_from_kaggle_dataset():
    zip_path = os.path.join(TMP_ROOT, "music3_cache.zip")
    url = f"https://www.kaggle.com/api/v1/datasets/download/{CACHE_DATASET_SLUG}"
    log(f"Found remote Kaggle cache dataset {CACHE_DATASET_SLUG}; pulling archive...")
    rc = subprocess.run(
        ["curl", "-fL", "--retry", "3", "-H", f"Authorization: Bearer {KAGGLE_API_TOKEN}", "-o", zip_path, url],
        capture_output=True, text=True
    )
    if rc.returncode == 0 and os.path.exists(zip_path):
        import zipfile
        try:
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(PERSIST_MODELS_DIR)
            os.remove(zip_path)
            return True
        except Exception as e:
            log(f"Archive extract note: {e}")
    return False

def ensure_models() -> dict:
    # Private account-owned CPU-published cache only. No GPU-time HF fallback.
    resolved={}
    for spec in MODEL_SPECS:
        src=scan_kaggle_inputs(spec['filename'],spec['expected_bytes'])
        if not src or os.path.getsize(src)!=spec['expected_bytes']:
            raise RuntimeError('Required Joshbond123 model cache asset missing: '+spec['filename'])
        resolved[spec['filename']]=src
    STATE['storage_sources']={name:'joshbond123_private_mounted_cache' for name in resolved}
    STATE['dataset_cached']=True
    return resolved

def publish_persistent_dataset_bg(model_paths: dict):
    def _worker():
        try:
            if check_dataset_exists_remote():
                log("Persistent Kaggle dataset already published and verified.")
                STATE["dataset_cached"] = True
                return
            log(f"Publishing persistent Kaggle dataset {CACHE_DATASET_SLUG} so restarts never re-download...")
            up_dir = os.path.join(TMP_ROOT, "dataset_upload_music3")
            os.makedirs(up_dir, exist_ok=True)
            for fn, src in model_paths.items():
                dst = os.path.join(up_dir, fn)
                if not os.path.exists(dst):
                    try:
                        os.link(src, dst)
                    except OSError:
                        shutil.copy2(src, dst)
            with open(os.path.join(up_dir, "dataset-metadata.json"), "w") as f:
                json.dump({
                    "title": CACHE_DATASET_TITLE,
                    "id": CACHE_DATASET_SLUG,
                    "licenses": [{"name": "other"}],
                }, f)
            os.makedirs("/tmp/.kaggle", exist_ok=True)
            with open("/tmp/.kaggle/kaggle.json", "w") as f:
                json.dump({"username": KAGGLE_USERNAME, "key": KAGGLE_API_TOKEN}, f)
            os.chmod("/tmp/.kaggle/kaggle.json", 0o600)
            env = dict(os.environ, KAGGLE_USERNAME=KAGGLE_USERNAME, KAGGLE_KEY=KAGGLE_API_TOKEN, KAGGLE_API_TOKEN=KAGGLE_API_TOKEN, KAGGLE_CONFIG_DIR="/tmp/.kaggle")
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "kaggle"], check=False)
            c = subprocess.run(["kaggle", "datasets", "create", "-p", up_dir, "--dir-mode", "skip", "-q"], env=env, capture_output=True, text=True)
            if c.returncode != 0:
                v = subprocess.run(["kaggle", "datasets", "version", "-p", up_dir, "-m", "Verified MiniMax Music 3 Q4_0 GGUF", "--dir-mode", "skip", "-q"], env=env, capture_output=True, text=True)
                log(f"Dataset version rc={v.returncode} out={v.stdout} err={v.stderr[:200]}")
            else:
                log(f"Dataset create rc=0 out={c.stdout}")
            STATE["dataset_cached"] = True
            shutil.rmtree(up_dir, ignore_errors=True)
        except Exception as e:
            log(f"Dataset publish background note: {e}")
    threading.Thread(target=_worker, daemon=True).start()

def setup_comfyui(model_paths: dict):
    STATE["stage"] = "installing_comfyui"
    subprocess.run(["apt-get", "update", "-qq"], check=False)
    subprocess.run(["apt-get", "install", "-y", "-qq", "ffmpeg"], check=False)
    subprocess.run([
        sys.executable, "-m", "pip", "install", "-q",
        "websocket-client", "fastapi", "uvicorn", "pydantic", "gguf>=0.13.0", "soundfile", "av", "einops", "safetensors", "huggingface_hub", "aiohttp", "kornia", "spandrel", "torchsde"
    ], check=False)

    if not os.path.exists(os.path.join(COMFY_DIR, "main.py")):
        log("Cloning ComfyUI...")
        subprocess.run(["git", "clone", "--depth", "1", "https://github.com/comfyanonymous/ComfyUI.git", COMFY_DIR], check=True)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", os.path.join(COMFY_DIR, "requirements.txt")], check=False)

    gguf_node_dir = os.path.join(COMFY_DIR, "custom_nodes", "ComfyUI-GGUF")
    if not os.path.exists(gguf_node_dir):
        log("Cloning molbal/ComfyUI-GGUF custom node...")
        subprocess.run(["git", "clone", "--depth", "1", "https://github.com/molbal/ComfyUI-GGUF.git", gguf_node_dir], check=True)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", os.path.join(gguf_node_dir, "requirements.txt")], check=False)

    # Stream any /kaggle/input (gcsfuse) files sequentially onto fast local NVMe SSD (fast_disk=True) so mmap() runs at 2,500 MB/s instead of 4 KB gcsfuse page-fault RPCs (zero re-downloads from HF!)
    best_ssd_root = max([d for d in ("/kaggle/tmp", "/tmp", "/var/tmp") if os.path.isdir(d)], key=lambda d: shutil.disk_usage(d).free)
    nvme_stage_dir = os.path.join(best_ssd_root, "vibely_nvme_music3")
    os.makedirs(nvme_stage_dir, exist_ok=True)
    log(f"Selected fast local SSD mount {best_ssd_root} ({shutil.disk_usage(best_ssd_root).free / 1e9:.1f} GB free) for NVMe mmap staging")

    def _stage_one(spec):
        fn = spec["filename"]
        src = model_paths[fn]
        if src.startswith("/kaggle/input/"):
            sz = os.path.getsize(src)
            dst_nvme = os.path.join(nvme_stage_dir, fn)
            if os.path.exists(dst_nvme) and os.path.getsize(dst_nvme) == sz:
                return fn, dst_nvme
            if shutil.disk_usage(nvme_stage_dir).free > sz + 2_000_000_000:
                t_s = time.time()
                with open(src, "rb", buffering=16 * 1024 * 1024) as rf, open(dst_nvme, "wb", buffering=16 * 1024 * 1024) as wf:
                    digest=hashlib.sha256()
                    for block in iter(lambda:rf.read(16*1024*1024),b''):
                        digest.update(block);wf.write(block)
                    if digest.hexdigest()!=spec['sha256']:
                        raise RuntimeError('Music cache SHA-256 mismatch: '+fn)
                dt = max(0.01, time.time() - t_s)
                log(f"Staged {fn} ({sz/1e9:.2f} GB) from /kaggle/input -> local NVMe in {dt:.1f}s ({(sz/1e6)/dt:.0f} MB/s)")
                return fn, dst_nvme
        return fn, src

    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        staged_map = dict(ex.map(_stage_one, MODEL_SPECS))

    for spec in MODEL_SPECS:
        fn = spec["filename"]
        src = staged_map[fn]
        for subdir in spec["comfy_dirs"]:
            target_dir = os.path.join(COMFY_DIR, "models", subdir)
            os.makedirs(target_dir, exist_ok=True)
            dst = os.path.join(target_dir, fn)
            if os.path.lexists(dst):
                os.remove(dst)
            os.symlink(src, dst)

    # Patch ComfyUI + ComfyUI-GGUF on pre-Ampere GPUs (Tesla T4 SM 7.5) so hardware FP16 Tensor Cores (65 TFLOPS) are used instead of software-emulated BF16 / slow FP32!
    ar_fp = os.path.join(COMFY_DIR, "comfy/ldm/minimax_music/ar.py")
    if os.path.exists(ar_fp):
        ar_txt = open(ar_fp, "r", encoding="utf-8").read()
        ar_patched = ar_txt.replace("execution_dtype = torch.float32", "execution_dtype = torch.float16").replace("execution_dtype = torch.bfloat16", "execution_dtype = torch.float16")
        open(ar_fp, "w", encoding="utf-8").write(ar_patched)
        log("Applied SM75 FP16 Tensor-Core patch to comfy/ldm/minimax_music/ar.py")

    for rel_p in (
        "comfy/text_encoders/minimax_music.py",
        "comfy/supported_models.py",
        "custom_nodes/ComfyUI-GGUF/nodes.py",
    ):
        fp = os.path.join(COMFY_DIR, rel_p)
        if os.path.exists(fp):
            src_txt = open(fp, "r", encoding="utf-8").read()
            patched = (
                src_txt
                .replace("dtype = torch.bfloat16", "dtype = torch.float16")
                .replace("compute_dtype = torch.bfloat16", "compute_dtype = torch.float16")
                .replace("compute_dtype=torch.bfloat16", "compute_dtype=torch.float16")
                .replace("supported_inference_dtypes = [torch.bfloat16, torch.float32]", "supported_inference_dtypes = [torch.float16, torch.bfloat16, torch.float32]")
                .replace("allowed_dtypes=[torch.bfloat16, torch.float32]", "allowed_dtypes=[torch.float16, torch.bfloat16, torch.float32]")
            )
            if patched != src_txt:
                open(fp, "w", encoding="utf-8").write(patched)
                log(f"Applied SM75 FP16 Tensor-Core acceleration patch to {rel_p}")

    log("Linked all MiniMax Music 3 Q4_0 GGUF model files into ComfyUI.")

COMFY_PROC = None
def start_comfyui():
    global COMFY_PROC
    STATE["stage"] = "starting_comfyui"
    log("Launching ComfyUI server on 127.0.0.1:8188...")
    comfy_log = open(os.path.join(WORK_ROOT, "comfyui_music3.log"), "a")
    COMFY_PROC = subprocess.Popen(
        [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch"],
        cwd=COMFY_DIR, stdout=comfy_log, stderr=subprocess.STDOUT
    )
    for _ in range(180):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=3) as r:
                if r.status == 200:
                    STATE["comfyui_ready"] = True
                    STATE["stage"] = "ready"
                    log("ComfyUI is LIVE on 127.0.0.1:8188!")
                    return
        except Exception:
            time.sleep(2)
    raise RuntimeError("ComfyUI failed to become ready within 360s")


def watch_comfy_progress(job_id):
    """Read real node/step events; never infer progress from elapsed time."""
    import websocket
    client_id=uuid.uuid4().hex
    ws=websocket.create_connection("ws://127.0.0.1:8188/ws?clientId="+client_id, timeout=5)
    def read():
        try:
            while True:
                try: raw=ws.recv()
                except websocket.WebSocketTimeoutException: continue
                if not isinstance(raw,str): continue
                event=json.loads(raw);kind=event.get("type");d=event.get("data",{})
                if kind not in ("executing","progress","execution_cached","execution_success","execution_error"): continue
                with JOBS_LOCK:
                    job=JOBS.get(job_id)
                    if not job: return
                    job["last_progress_at"]=time.time()
                    if kind=="executing":
                        job["node_id"]=d.get("node")
                        job.setdefault("node_events",[]).append({"node":d.get("node"),"at":time.time()})
                    if kind=="progress":
                        job["step"]=d.get("value");job["step_max"]=d.get("max")
                        base=(job.get("current_scene",1)-1)/max(1,job.get("total_scenes",1))
                        fraction=float(d.get("value",0))/max(1,float(d.get("max",1)))
                        job["progress"]=round(5+80*(base+fraction/max(1,job.get("total_scenes",1))))
                if kind in ("execution_success","execution_error") or (kind=="executing" and d.get("node") is None):return
        except Exception as e: log("Progress stream closed: "+str(e))
        finally:ws.close()
    threading.Thread(target=read,daemon=True).start()
    return client_id

def run_music_generation_job(job_id, payload):
    with MUSIC_EXECUTION_LOCK:
        _run_music_generation_job(job_id,payload)

def _run_music_generation_job(job_id: str, payload: dict):
    try:
        with JOBS_LOCK:
            JOBS[job_id]["status"] = "running"
            JOBS[job_id]["stage"] = "submitting_comfyui_workflow"
            JOBS[job_id]["progress"] = 10

        caption = payload.get("caption") or "Global Metadata: Amapiano and Afrobeats Fusion, 113 BPM, F minor, club-ready infectious groove.\nVocal Details: Confident glamorous female lead vocal, catchy melodic hook, airy harmonies.\nArrangement: Deep punchy Amapiano log drums, crisp Afrobeats shakers and syncopated rimshots, warm Rhodes chords, energetic drop."
        lyrics = payload.get("lyrics") or "[Intro]\nYeah, Scarlett on the beat\n\n[Chorus]\nMove your hips to the log drum sound\nFeel that bounce when the bass drops down\n\n[Instrumental]\n\n[Outro]\nVibely all night"
        duration_sec = float(payload.get("duration_sec") or 30.0)
        duration_sec = max(20.0, min(180.0, duration_sec))
        seed = int(payload.get("seed") or (int(time.time() * 1000) % 2147483647))
        steps = int(payload.get("steps") or 24)
        cfg_scale = float(payload.get("cfg_scale") or 1.7)
        top_k = int(payload.get("top_k") or 50)
        prefix = f"audio/vibely_{job_id}"

        workflow = {
            "1": {
                "class_type": "CLIPLoaderGGUF",
                "inputs": {
                    "clip_name": "minimax_music3_text_encoder_pruned_Q4_0.gguf",
                    "type": "minimax"
                }
            },
            "2": {
                "class_type": "UnetLoaderGGUF",
                "inputs": {
                    "unet_name": "minimax_music3_dit_Q4_0.gguf"
                }
            },
            "3": {
                "class_type": "VAELoader",
                "inputs": {
                    "vae_name": "minimax_music3_dav.safetensors"
                }
            },
            "4": {
                "class_type": "MiniMaxMusic3TextEncode",
                "inputs": {
                    "clip": ["1", 0],
                    "caption": caption,
                    "lyrics": lyrics,
                    "seed": seed,
                    "max_duration": duration_sec + 4.0,
                    "cfg_scale": cfg_scale,
                    "top_k": top_k
                }
            },
            "5": {
                "class_type": "ConditioningZeroOut",
                "inputs": {
                    "conditioning": ["4", 0]
                }
            },
            "6": {
                "class_type": "EmptyMiniMaxMusic3LatentAudio",
                "inputs": {
                    "seconds": ["4", 1],
                    "batch_size": 1
                }
            },
            "7": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["2", 0],
                    "positive": ["4", 0],
                    "negative": ["5", 0],
                    "latent_image": ["6", 0],
                    "seed": seed,
                    "steps": steps,
                    "cfg": cfg_scale,
                    "sampler_name": "euler",
                    "scheduler": "simple",
                    "denoise": 1.0
                }
            },
            "8": {
                "class_type": "VAEDecodeAudioTiled",
                "inputs": {
                    "samples": ["7", 0],
                    "vae": ["3", 0],
                    "tile_size": 1536,
                    "overlap": 64
                }
            },
            "9": {
                "class_type": "SaveAudioMP3",
                "inputs": {
                    "audio": ["8", 0],
                    "filename_prefix": prefix,
                    "quality": "V0"
                }
            }
        }

        client_id=watch_comfy_progress(job_id)
        req_data = json.dumps({"prompt": workflow,"client_id":client_id}).encode()
        req = urllib.request.Request("http://127.0.0.1:8188/prompt", data=req_data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            prompt_id = json.loads(resp.read().decode())["prompt_id"]

        with JOBS_LOCK:
            JOBS[job_id]["comfyui_prompt_id"] = prompt_id
            JOBS[job_id]["stage"] = "synthesizing_amapiano_afrobeats_audio"
            JOBS[job_id]["progress"] = 25

        out_audio_path = None
        t_start = time.time()
        while time.time() - t_start < 1800:
            with urllib.request.urlopen(f"http://127.0.0.1:8188/history/{prompt_id}", timeout=10) as hr:
                hist = json.loads(hr.read().decode())
            if prompt_id in hist:
                entry = hist[prompt_id]
                status_info = entry.get("status", {})
                if status_info.get("status_str") == "error":
                    raise RuntimeError(f"ComfyUI execution error: {json.dumps(status_info)}")
                outputs = entry.get("outputs", {})
                for nid, nout in outputs.items():
                    for key in ("audio", "files", "gifs"):
                        if key in nout and nout[key]:
                            item = nout[key][0]
                            sub = item.get("subfolder", "")
                            fn = item["filename"]
                            cand = os.path.join(COMFY_DIR, "output", sub, fn)
                            if os.path.exists(cand):
                                out_audio_path = cand
                                break
                if out_audio_path:
                    break
            time.sleep(2)

        if not out_audio_path or not os.path.exists(out_audio_path):
            raise RuntimeError("Timed out waiting for ComfyUI audio output")

        final_mp3 = os.path.join(JOBS_DIR, f"{job_id}.mp3")
        fade_start = max(1.0, duration_sec - 1.5)
        subprocess.run([
            "ffmpeg", "-y", "-i", out_audio_path,
            "-t", f"{duration_sec:.2f}",
            "-af", f"afade=t=in:st=0:d=0.4,afade=t=out:st={fade_start:.2f}:d=1.5",
            "-ar", "32000", "-ac", "2", "-b:a", "192k",
            final_mp3
        ], check=True, capture_output=True)

        # Probe actual duration
        pr = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", final_mp3],
            capture_output=True, text=True
        )
        actual_dur = float((pr.stdout or str(duration_sec)).strip())

        with JOBS_LOCK:
            JOBS[job_id].update({
                "status": "completed",
                "stage": "completed",
                "progress": 100,
                "output_path": final_mp3,
                "duration_sec": round(actual_dur, 2),
                "completed_at": time.time(),
                "workflow_used": workflow,
            })
        log(f"Job {job_id} completed ({actual_dur:.2f}s MP3)")
    except Exception as e:
        try:
            urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8188/interrupt',data=b'{}',headers={'Content-Type':'application/json'}),timeout=5).close()
        except Exception: pass
        tb = traceback.format_exc()
        log(f"Job {job_id} FAILED: {e}\n{tb}")
        with JOBS_LOCK:
            JOBS[job_id].update({
                "status": "failed",
                "stage": "failed",
                "error": str(e),
            })

def start_cloudflared_and_heartbeat():
    cf_bin = "/tmp/cloudflared"
    if not os.path.exists(cf_bin):
        subprocess.run([
            "curl", "-fsSL",
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
            "-o", cf_bin
        ], check=True)
        os.chmod(cf_bin, 0o755)

    def _tunnel_loop():
        while True:
            cf_log = "/tmp/cloudflared_music3.log"
            if os.path.exists(cf_log):
                os.remove(cf_log)
            proc = subprocess.Popen(
                [cf_bin, "tunnel", "--url", "http://127.0.0.1:8000", "--no-autoupdate"],
                stdout=open(cf_log, "w"), stderr=subprocess.STDOUT
            )
            found_url = ""
            for _ in range(60):
                if os.path.exists(cf_log):
                    txt = open(cf_log).read()
                    m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", txt)
                    if m:
                        found_url = m.group(0)
                        break
                time.sleep(1)
            if found_url:
                STATE["tunnel_url"] = found_url
                log(f"VIBELY_MUSIC_TUNNEL_URL={found_url}")
                with open(os.path.join(WORK_ROOT, "tunnel_status.json"), "w") as tf:
                    json.dump({"service": "minimax-music-3", "username": KAGGLE_USERNAME, "tunnel_url": found_url, "updated_at": time.time()}, tf)
                _send_heartbeat()
            proc.wait()
            log("cloudflared exited; restarting in 3s...")
            time.sleep(3)

    _LAST_PUB = {"sig": ""}
    def _publish_endpoint_dataset(payload_dict: dict):
        sig = f"{payload_dict.get('endpoint_url')}|{payload_dict.get('comfyui_ready')}|{payload_dict.get('dataset_cached')}"
        if sig == _LAST_PUB["sig"] or not payload_dict.get("endpoint_url"):
            return
        _LAST_PUB["sig"] = sig
        try:
            ep_dir = "/tmp/ep_pub_music3"
            os.makedirs(ep_dir, exist_ok=True)
            with open(os.path.join(ep_dir, "endpoint.json"), "w") as ef:
                json.dump(payload_dict, ef)
            with open(os.path.join(ep_dir, "dataset-metadata.json"), "w") as mf:
                json.dump({
                    "title": "VIBELY Music3 Live Endpoint",
                    "id": "joshbond123/vibely-music3-live-endpoint",
                    "licenses": [{"name": "other"}],
                }, mf)
            os.makedirs("/tmp/.kaggle_ep", exist_ok=True)
            with open("/tmp/.kaggle_ep/kaggle.json", "w") as kf:
                json.dump({"username": "joshbond123", "key": KAGGLE_API_TOKEN}, kf)
            os.chmod("/tmp/.kaggle_ep/kaggle.json", 0o600)
            env = dict(os.environ, KAGGLE_USERNAME="joshbond123", KAGGLE_KEY=KAGGLE_API_TOKEN, KAGGLE_API_TOKEN=KAGGLE_API_TOKEN, KAGGLE_CONFIG_DIR="/tmp/.kaggle_ep")
            subprocess.run([sys.executable, "-m", "pip", "install", "-q", "kaggle"], check=False)
            c = subprocess.run(["kaggle", "datasets", "create", "-p", ep_dir, "--dir-mode", "skip", "-q"], env=env, capture_output=True, text=True)
            if c.returncode != 0:
                subprocess.run(["kaggle", "datasets", "version", "-p", ep_dir, "-m", f"ready={payload_dict.get('comfyui_ready')}", "--dir-mode", "skip", "-q"], env=env, capture_output=True, text=True)
        except Exception as e:
            log(f"Endpoint dataset note: {e}")

    def _send_heartbeat():
        if not STATE.get("tunnel_url"):
            return
        payload_dict = {
            "worker_version":"lifecycle-v3",
            "worker_started_at":STATE["started_at"],
            "service": "minimax_music_3",
            "username": KAGGLE_USERNAME,
            "model_name": "MiniMax Music 3 Q4_0 GGUF",
            "endpoint_url": STATE["tunnel_url"],
            "api_key": API_KEY,
            "comfyui_ready": STATE["comfyui_ready"],
            "dataset_cached": STATE["dataset_cached"],
            "storage_sources": STATE["storage_sources"],
            "gpu_name": STATE["gpu_name"],
            "updated_at": time.time(),
        }
        threading.Thread(target=_publish_endpoint_dataset, args=(payload_dict,), daemon=True).start()
        body = json.dumps(payload_dict).encode()
        for base_u in ("https://aivideo.aivideo.blitz.cloud", "https://vibely.aivideo.blitz.cloud", "https://aivideo.blitz.cloud"):
            try:
                req = urllib.request.Request(
                    f"{base_u}/api/models/register",
                    data=body,
                    headers={"Content-Type": "application/json", "X-Registry-Secret": REGISTRY_SECRET},
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=8).read()
            except Exception:
                pass

    def _hb_loop():
        while True:
            _send_heartbeat()
            time.sleep(30)

    threading.Thread(target=_tunnel_loop, daemon=True).start()
    threading.Thread(target=_hb_loop, daemon=True).start()

def main():
    def _bounded_session():
        while not SHUTDOWN_REQUESTED.wait(5):
            elapsed=time.time()-STATE['started_at']
            if (not STATE['comfyui_ready'] and elapsed>18*60) or elapsed>2*3600:
                if COMFY_PROC is not None and COMFY_PROC.poll() is None: COMFY_PROC.kill()
                os._exit(1)
    threading.Thread(target=_bounded_session,daemon=True).start()
    try:
        gpu_q = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True)
        STATE["gpu_name"] = (gpu_q.stdout or "Kaggle GPU").strip()
        log(f"Detected GPU: {STATE['gpu_name']}")
    except Exception:
        pass

    # Start FastAPI immediately so tunnel and health reporting are live during setup!
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "fastapi", "uvicorn"], check=False)
    from fastapi import FastAPI, Header, HTTPException
    from fastapi.responses import FileResponse, JSONResponse
    import uvicorn

    app = FastAPI(title="VIBELY MiniMax Music 3 Q4_0 GGUF ComfyUI API")

    def verify_auth(authorization: str = Header(default="")):
        if authorization != f"Bearer {API_KEY}":
            raise HTTPException(status_code=401, detail="Unauthorized")

    @app.get("/health")
    def health():
        return {
            "ok": True,
            "worker_version":"lifecycle-v3",
            "worker_started_at":STATE["started_at"],
            "service": "minimax_music_3",
            "username": KAGGLE_USERNAME,
            "model": "MiniMax Music 3 Q4_0 GGUF",
            "genre": "Amapiano + Afrobeats Fusion",
            "stage": STATE["stage"],
            "comfyui_ready": STATE["comfyui_ready"],
            "dataset_cached": STATE["dataset_cached"],
            "storage_sources": STATE["storage_sources"],
            "gpu": STATE["gpu_name"],
            "tunnel_url": STATE["tunnel_url"],
            "uptime_sec": round(time.time() - STATE["started_at"], 1),
            "last_error": STATE["last_error"],
        }

    @app.post("/v1/music/jobs")
    def create_music_job(payload: dict, authorization: str = Header(default="")):
        verify_auth(authorization)
        if SHUTDOWN_REQUESTED.is_set(): raise HTTPException(status_code=503,detail="Worker is shutting down")
        if not STATE["comfyui_ready"]:
            raise HTTPException(status_code=503, detail=f"ComfyUI still {STATE['stage']}")
        request_id=str(payload.get("request_id") or "")
        job_id = "mus_" + (__import__('hashlib').sha256(request_id.encode()).hexdigest()[:20] if request_id else uuid.uuid4().hex[:12])
        with JOBS_LOCK:
            if job_id in JOBS:return {"ok":True,"job_id":job_id,"status":JOBS[job_id]["status"]}
            if sum(j.get("status") in ("queued","running") for j in JOBS.values())>=3:
                raise HTTPException(status_code=429,detail="GPU queue full; retry after current jobs complete")
            JOBS[job_id] = {
                "job_id": job_id,
                "status": "queued",
                "stage": "queued",
                "progress": 0,
                "created_at": time.time(),
            }
        threading.Thread(target=run_music_generation_job, args=(job_id, payload), daemon=True).start()
        return {"ok": True, "job_id": job_id, "status": "queued"}

    @app.get("/v1/music/jobs/{job_id}")
    def get_music_job(job_id: str, authorization: str = Header(default="")):
        verify_auth(authorization)
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                raise HTTPException(status_code=404, detail="Job not found")
            return dict(job)

    @app.get("/v1/music/jobs/{job_id}/audio")
    def download_music_audio(job_id: str, authorization: str = Header(default="")):
        verify_auth(authorization)
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job or job.get("status") != "completed":
                raise HTTPException(status_code=404, detail="Audio not ready")
            path = job["output_path"]
        return FileResponse(path, media_type="audio/mpeg", filename=f"{job_id}.mp3")

    @app.get("/v1/logs")
    def read_music_logs(authorization: str = Header(default="")):
        verify_auth(authorization)
        out = {}
        for fn in ("vibely_music3.log", "comfyui_music3.log"):
            p = os.path.join(WORK_ROOT, fn)
            out[fn] = open(p, errors="replace").read()[-6000:] if os.path.exists(p) else ""
        return out

    @app.get("/v1/telemetry")
    def gpu_telemetry(authorization: str = Header(default="")):
        verify_auth(authorization)
        cmd=["nvidia-smi","--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu","--format=csv,noheader,nounits"]
        result=subprocess.run(cmd,capture_output=True,text=True,timeout=8)
        if result.returncode: raise HTTPException(status_code=503,detail="nvidia-smi unavailable")
        gpus=[]
        def num(x):
            try:return float(x)
            except ValueError:return None
        for line in result.stdout.strip().splitlines():
            a=[x.strip() for x in line.split(',')]
            if len(a)==6:gpus.append({"index":num(a[0]),"name":a[1],"utilization_percent":num(a[2]),"memory_used_mib":num(a[3]),"memory_total_mib":num(a[4]),"temperature_c":num(a[5])})
        with JOBS_LOCK:active=[j for j in JOBS.values() if j.get('status') in ('running','queued')]
        return {"measured_at":time.time(),"gpus":gpus,"active_jobs":len(active),"current_tasks":[j.get('stage') for j in active],"session_started_at":STATE['started_at']}

    @app.post("/v1/music/jobs/{job_id}/acknowledge")
    def acknowledge_output(job_id: str, receipt: dict, authorization: str = Header(default="")):
        verify_auth(authorization)
        if not receipt.get('sha256') or not receipt.get('playable') or not receipt.get('bytes'):
            raise HTTPException(status_code=400,detail="Durable decoded-output receipt required")
        with JOBS_LOCK:
            job=JOBS.get(job_id)
            if not job or job.get('status')!='completed':raise HTTPException(status_code=409,detail="Output is not completed")
            job['persisted_receipt']=receipt;job['acknowledged_at']=time.time()
        return {"ok":True}

    @app.post("/v1/lifecycle/shutdown")
    def shutdown_worker(payload: dict, authorization: str = Header(default="")):
        verify_auth(authorization)
        with JOBS_LOCK:
            blockers=[j for j in JOBS.values() if j.get('status') in ('queued','running') or (j.get('status')=='completed' and not j.get('persisted_receipt'))]
            if blockers:raise HTTPException(status_code=409,detail="Running jobs or outputs not yet acknowledged as persisted")
            try:
                q=json.loads(urllib.request.urlopen('http://127.0.0.1:8188/queue',timeout=5).read().decode())
                if q.get('queue_running') or q.get('queue_pending'):raise HTTPException(status_code=409,detail="ComfyUI queue is not empty")
            except HTTPException:raise
            except Exception:
                if COMFY_PROC is not None and COMFY_PROC.poll() is None:raise HTTPException(status_code=503,detail="Cannot verify ComfyUI queue; refusing unsafe shutdown")
            SHUTDOWN_REQUESTED.set();STATE['stage']='shutting_down';STATE['comfyui_ready']=False
        return {"ok":True,"state":"STOPPING","session_termination":"script exits after ComfyUI terminates; Kaggle status must independently confirm completion"}

    @app.get("/v1/diagnostics")
    def music_diagnostics(authorization: str = Header(default="")):
        verify_auth(authorization)
        smi = subprocess.run(["nvidia-smi", "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,power.draw", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip()
        disks = {d: {"free_gb": round(shutil.disk_usage(d).free / 1e9, 2), "total_gb": round(shutil.disk_usage(d).total / 1e9, 2)} for d in ("/", "/tmp", "/kaggle/working", "/dev/shm") if os.path.isdir(d)}
        try:
            q = json.loads(urllib.request.urlopen("http://127.0.0.1:8188/queue", timeout=5).read().decode())
        except Exception as e:
            q = {"error": str(e)}
        return {"nvidia_smi": smi, "disks": disks, "comfyui_queue": q}

    @app.post("/v1/comfyui/prompt")
    def raw_comfy_prompt(payload: dict, authorization: str = Header(default="")):
        verify_auth(authorization)
        req = urllib.request.Request("http://127.0.0.1:8188/prompt", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())

    threading.Thread(target=lambda: uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning"), daemon=True).start()
    start_cloudflared_and_heartbeat()

    try:
        paths = ensure_models()
        # Cache was published and verified by the CPU-only installer.
        setup_comfyui(paths)
        start_comfyui()
    except Exception as e:
        STATE["last_error"] = str(e)
        STATE["stage"] = "error"
        log(f"FATAL SETUP ERROR: {e}\n{traceback.format_exc()}")
        try:
            payload=json.dumps({'service_id':'minimax_music_3','attempt_started_at':STATE['started_at'],'error':str(e)}).encode()
            urllib.request.urlopen(urllib.request.Request(VIBELY_BACKEND_URL+'/api/gpu/startup-failed',data=payload,headers={'Content-Type':'application/json','X-Registry-Secret':REGISTRY_SECRET}),timeout=10).close()
        except Exception: pass
        SHUTDOWN_REQUESTED.set()


    # Keep session alive up to 11.5 hours
    t0=time.time()
    idle_since=time.time()
    while time.time()-t0<11.5*3600:
        if SHUTDOWN_REQUESTED.is_set():break
        with JOBS_LOCK:
            busy=any(j.get('status') in ('queued','running') or (j.get('status')=='completed' and not j.get('persisted_receipt')) for j in JOBS.values())
        if busy:
            idle_since=time.time()
            if any(j.get('status')=='completed' and not j.get('persisted_receipt') and time.time()-j.get('completed_at',time.time())>600 for j in JOBS.values()):break
        elif time.time()-idle_since>30:
            try:
                req=urllib.request.Request(VIBELY_BACKEND_URL+'/api/gpu/leases?service_id=minimax_music_3',headers={'X-Registry-Secret':REGISTRY_SECRET})
                leases=json.loads(urllib.request.urlopen(req,timeout=8).read().decode())
                if leases.get('ok') and leases.get('pending')==0:
                    SHUTDOWN_REQUESTED.set();break
            except Exception:pass
            # Abandoned startup safety: no submitted work/output, never interrupt active inference.
            if not JOBS and time.time()-idle_since>15*60:
                log('No job arrived within startup grace; releasing unused GPU session.');break
        if COMFY_PROC is not None and COMFY_PROC.poll() is not None:
            STATE['comfyui_ready']=False;STATE['stage']='error';STATE['last_error']='ComfyUI exited; session will terminate rather than silently lose jobs'
            log(STATE['last_error']);break
        time.sleep(3)
    STATE['stage']='shutting_down';STATE['comfyui_ready']=False
    if COMFY_PROC is not None and COMFY_PROC.poll() is None:
        COMFY_PROC.terminate()
        try:COMFY_PROC.wait(timeout=20)
        except subprocess.TimeoutExpired:COMFY_PROC.kill();COMFY_PROC.wait(timeout=10)
    log('ComfyUI terminated; models and CUDA allocations released. Returning from Kaggle batch script.')
    try:
        body=json.dumps({'service_id':"minimax_music_3",'worker_started_at':STATE['started_at']}).encode()
        urllib.request.urlopen(urllib.request.Request(VIBELY_BACKEND_URL+'/api/gpu/stopped',data=body,headers={'Content-Type':'application/json','X-Registry-Secret':REGISTRY_SECRET}),timeout=10).close()
    except Exception:pass

if __name__ == "__main__":
    main()
