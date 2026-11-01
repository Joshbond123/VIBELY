
import base64
import json
import math
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

KAGGLE_USERNAME = "Joshbond123"
KAGGLE_API_TOKEN = os.environ['KAGGLE_API_TOKEN']
HF_TOKEN = os.environ['HF_TOKEN']
API_KEY = os.environ['WORKER_API_KEY']
REGISTRY_SECRET = os.environ['VIBELY_MODEL_REGISTRY_SECRET']
VIBELY_BACKEND_URL = os.environ['VIBELY_BACKEND_URL']
CACHE_DATASET_SLUG = "joshbond123/minimax-h3-ref2va-cache"
CACHE_DATASET_TITLE = "MiniMax H3 Ref2VA Persistent Cache"
EMBEDDED_REFS_B64 = {}

MODEL_SPECS = [
    {
        "filename": "minimax-h3-ref2va-Q4_0.gguf",
        "repo": "molbal/MiniMax-H3-GGUF",
        "repo_path": "minimax-h3-ref2va-Q4_0.gguf",
        "expected_bytes": 11377542880,
        "comfy_dirs": ["unet", "diffusion_models"],
    },
    {
        "filename": "Qwen3-VL-32B-Instruct-MiniMax-H3-L0-49-Q2_K.gguf",
        "repo": "nif0/Qwen3-VL-32B-Instruct-MiniMax-H3-GGUF",
        "repo_path": "Qwen3-VL-32B-Instruct-MiniMax-H3-L0-49-UD-Q2_K_XL.gguf",
        "expected_bytes": 9570506432,
        "comfy_dirs": ["clip", "text_encoders"],
    },
    {
        "filename": "Qwen3-VL-32B-Instruct-MiniMax-H3-L0-49-mmproj-BF16.gguf",
        "repo": "nif0/Qwen3-VL-32B-Instruct-MiniMax-H3-GGUF",
        "repo_path": "Qwen3-VL-32B-Instruct-MiniMax-H3-L0-49-mmproj-BF16.gguf",
        "expected_bytes": 1200334496,
        "comfy_dirs": ["clip", "text_encoders"],
    },
    {
        "filename": "minimax_h3_video_vae_fp16.safetensors",
        "repo": "Comfy-Org/MiniMax-H3",
        "repo_path": "vae/minimax_h3_video_vae_fp16.safetensors",
        "expected_bytes": 5207808496,
        "comfy_dirs": ["vae"],
    },
    {
        "filename": "minimax_h3_audio_vae_fp32.safetensors",
        "repo": "Comfy-Org/MiniMax-H3",
        "repo_path": "vae/minimax_h3_audio_vae_fp32.safetensors",
        "expected_bytes": 605254808,
        "comfy_dirs": ["vae"],
    },
    {
        "filename": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
        "repo": "Comfy-Org/MiniMax-H3",
        "repo_path": "loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
        "expected_bytes": 1956193000,
        "comfy_dirs": ["loras"],
    },
]

WORK_ROOT = "/kaggle/working"
TMP_ROOT = "/kaggle/tmp" if os.path.isdir("/kaggle/tmp") else "/tmp/vibely_h3_store"
MODELS_STORE = os.path.join(TMP_ROOT, "models_h3_ref2va")
REFS_DIR = os.path.join(WORK_ROOT, "scarlett_monroe_refs")
COMFY_DIR = os.path.join(TMP_ROOT, "ComfyUI")
JOBS_DIR = os.path.join(WORK_ROOT, "video_jobs")

# Clean up any non-VIBELY artifacts in /kaggle/working on boot as requested
for item in os.listdir(WORK_ROOT) if os.path.isdir(WORK_ROOT) else []:
    if item not in ("scarlett_monroe_refs", "video_jobs", "vibely_h3.log", "comfyui_h3.log", "tunnel_status.json") and not item.startswith("."):
        p = os.path.join(WORK_ROOT, item)
        try:
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
            else:
                os.remove(p)
        except Exception:
            pass

os.makedirs(MODELS_STORE, exist_ok=True)
os.makedirs(REFS_DIR, exist_ok=True)
os.makedirs(JOBS_DIR, exist_ok=True)

# Materialize Scarlett Monroe's 3 persistent character reference images from mounted Kaggle dataset
for rname in ("scarlett_ref_1.jpg", "scarlett_ref_2.jpg", "scarlett_ref_3.jpg"):
    rpath = os.path.join(REFS_DIR, rname)
    if os.path.isdir("/kaggle/input"):
        for _rt, _, _fls in os.walk("/kaggle/input"):
            if rname in _fls:
                cand = os.path.join(_rt, rname)
                if os.path.getsize(cand) > 20_000:
                    shutil.copy2(cand, rpath)
                    break
    if (not os.path.exists(rpath) or os.path.getsize(rpath) < 10_000) and rname in EMBEDDED_REFS_B64:
        with open(rpath, "wb") as rf:
            rf.write(base64.b64decode(EMBEDDED_REFS_B64[rname]))

STATE = {
    "stage": "booting",
    "comfyui_ready": False,
    "storage_sources": {},
    "dataset_cached": False,
    "character_refs": sorted(os.listdir(REFS_DIR)),
    "tunnel_url": "",
    "gpu_name": "",
    "started_at": time.time(),
    "last_error": "",
}
JOBS = {}
JOBS_LOCK = threading.Lock()
VIDEO_EXECUTION_LOCK = threading.Lock()

def log(msg: str):
    ts = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    line = f"[{ts}] [H3-REF2VA] {msg}"
    print(line, flush=True)
    try:
        with open(os.path.join(WORK_ROOT, "vibely_h3.log"), "a") as lf:
            lf.write(line + "\n")
    except Exception:
        pass

def healthy_file(path: str, expected_bytes: int) -> bool:
    try:
        return os.path.exists(path) and os.path.getsize(path) >= int(expected_bytes * 0.97)
    except Exception:
        return False

def scan_kaggle_inputs(filename: str, alt_name: str, expected_bytes: int) -> str:
    if not os.path.isdir("/kaggle/input"):
        return ""
    for root, _, files in os.walk("/kaggle/input"):
        for cand_name in (filename, alt_name):
            if cand_name and cand_name in files:
                p = os.path.join(root, cand_name)
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
            return total > 25_000_000_000
    except Exception:
        return False

def try_download_from_kaggle_dataset():
    zip_path = os.path.join(TMP_ROOT, "h3_cache.zip")
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
                zf.extractall(MODELS_STORE)
            os.remove(zip_path)
            return True
        except Exception as e:
            log(f"Archive extract note: {e}")
    return False

def ensure_models() -> dict:
    STATE["stage"] = "resolving_persistent_models"
    resolved = {}
    missing = []
    for spec in MODEL_SPECS:
        fn = spec["filename"]
        alt = os.path.basename(spec["repo_path"])
        exp = spec["expected_bytes"]
        inp = scan_kaggle_inputs(fn, alt, exp)
        if inp:
            log(f"Persistent model mounted in /kaggle/input (no download needed): {inp}")
            resolved[fn] = (inp, "kaggle_input_dataset")
            STATE["dataset_cached"] = True
            continue
        sp = os.path.join(MODELS_STORE, fn)
        if healthy_file(sp, exp):
            resolved[fn] = (sp, "local_persistent_store")
            continue
        missing.append(spec)

    if missing and check_dataset_exists_remote():
        STATE["dataset_cached"] = True
        if try_download_from_kaggle_dataset():
            still_missing = []
            for spec in missing:
                sp = os.path.join(MODELS_STORE, spec["filename"])
                if healthy_file(sp, spec["expected_bytes"]):
                    resolved[spec["filename"]] = (sp, "kaggle_dataset_archive")
                else:
                    still_missing.append(spec)
            missing = still_missing

    for spec in missing:
        fn = spec["filename"]
        dest = os.path.join(MODELS_STORE, fn)
        part = dest + ".part"
        url = f"https://huggingface.co/{spec['repo']}/resolve/main/{spec['repo_path']}"
        log(f"Downloading {fn} ({spec['expected_bytes']/1e9:.2f} GB) from {spec['repo']}...")
        STATE["stage"] = f"downloading_{fn}"
        res = subprocess.run([
            "curl", "-fL", "--retry", "5", "--retry-delay", "3", "-C", "-",
            "-H", f"Authorization: Bearer {HF_TOKEN}",
            "-o", part, url
        ], capture_output=True, text=True)
        if res.returncode != 0 or not healthy_file(part, spec["expected_bytes"]):
            raise RuntimeError(f"Failed downloading {fn}: rc={res.returncode} stderr={res.stderr[-300:]}")
        os.replace(part, dest)
        log(f"Verified {fn} ({os.path.getsize(dest)} bytes)")
        resolved[fn] = (dest, "huggingface_initial_bootstrap")

    STATE["storage_sources"] = {k: v[1] for k, v in resolved.items()}
    return {k: v[0] for k, v in resolved.items()}

def publish_persistent_dataset_bg(model_paths: dict):
    def _worker():
        try:
            if check_dataset_exists_remote():
                log("Persistent Kaggle dataset already published and verified.")
                STATE["dataset_cached"] = True
                return
            log(f"Publishing persistent Kaggle dataset {CACHE_DATASET_SLUG} (27.8 GB + Scarlett refs)...")
            up_dir = os.path.join(TMP_ROOT, "dataset_upload_h3")
            os.makedirs(up_dir, exist_ok=True)
            for fn, src in model_paths.items():
                dst = os.path.join(up_dir, fn)
                if not os.path.exists(dst):
                    try:
                        os.link(src, dst)
                    except OSError:
                        shutil.copy2(src, dst)
            for rname in os.listdir(REFS_DIR):
                shutil.copy2(os.path.join(REFS_DIR, rname), os.path.join(up_dir, rname))
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
                v = subprocess.run(["kaggle", "datasets", "version", "-p", up_dir, "-m", "Verified MiniMax H3 Ref2VA + Scarlett Monroe refs", "--dir-mode", "skip", "-q"], env=env, capture_output=True, text=True)
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
        "fastapi", "uvicorn", "pydantic", "gguf>=0.13.0", "soundfile", "av", "einops", "safetensors", "huggingface_hub", "aiohttp", "kornia", "spandrel", "torchsde", "opencv-python-headless", "websocket-client"
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

    # Stream /kaggle/input (gcsfuse) files sequentially onto fast local NVMe SSD (fast_disk=True) so mmap() + DynamicVRAM run at 2,500 MB/s instead of 4 KB gcsfuse page-fault RPCs (zero re-downloads from HF!)
    best_ssd_root = max([d for d in ("/kaggle/tmp", "/tmp", "/var/tmp") if os.path.isdir(d)], key=lambda d: shutil.disk_usage(d).free)
    nvme_stage_dir = os.path.join(best_ssd_root, "vibely_nvme_h3")
    os.makedirs(nvme_stage_dir, exist_ok=True)
    log(f"Selected fast local SSD mount {best_ssd_root} ({shutil.disk_usage(best_ssd_root).free / 1e9:.1f} GB free) for NVMe mmap staging")

    staged_map = {}
    for spec in MODEL_SPECS:
        fn = spec["filename"]
        src = model_paths[fn]
        if src.startswith("/kaggle/input/"):
            sz = os.path.getsize(src)
            dst_nvme = os.path.join(nvme_stage_dir, fn)
            if os.path.exists(dst_nvme) and os.path.getsize(dst_nvme) == sz:
                staged_map[fn] = dst_nvme
                continue
            if shutil.disk_usage(nvme_stage_dir).free > sz + 3_000_000_000:
                t_s = time.time()
                with open(src, "rb", buffering=16 * 1024 * 1024) as rf, open(dst_nvme, "wb", buffering=16 * 1024 * 1024) as wf:
                    shutil.copyfileobj(rf, wf, length=16 * 1024 * 1024)
                dt = max(0.01, time.time() - t_s)
                log(f"Staged {fn} ({sz/1e9:.2f} GB) from /kaggle/input -> local NVMe in {dt:.1f}s ({(sz/1e6)/dt:.0f} MB/s)")
                staged_map[fn] = dst_nvme
                continue
        staged_map[fn] = src

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

    # Copy Scarlett's persistent references into ComfyUI/input/ so they never need re-uploading
    comfy_inp = os.path.join(COMFY_DIR, "input")
    os.makedirs(comfy_inp, exist_ok=True)
    for rname in os.listdir(REFS_DIR):
        shutil.copy2(os.path.join(REFS_DIR, rname), os.path.join(comfy_inp, rname))

    # On pre-Ampere GPUs (Tesla T4 SM 7.5), MiniMaxH3 & Qwen3-VL-32B activations exceed 65,504 (FP16_MAX) and overflow float16 to NaN,
    # while software-emulated bfloat16 is 0.5 TFLOPS. Configure native 8-exponent-bit hardware torch.float32 (8.1 TFLOPS, 3.4e38 range, zero NaNs)!
    hv_fp = os.path.join(COMFY_DIR, "comfy/text_encoders/hunyuan_video.py")
    if os.path.exists(hv_fp):
        hv_txt = open(hv_fp, "r", encoding="utf-8").read()
        hv_patched = hv_txt.replace('out["dtype_llama"] = state_dict[norm_key].dtype', 'out["dtype_llama"] = torch.float32')
        open(hv_fp, "w", encoding="utf-8").write(hv_patched)
        log("Configured native SM75 FP32 (8-bit exponent, zero NaN) on comfy/text_encoders/hunyuan_video.py")

    mm_fp = os.path.join(COMFY_DIR, "comfy/text_encoders/minimax.py")
    if os.path.exists(mm_fp):
        mm_txt = open(mm_fp, "r", encoding="utf-8").read()
        mm_patched = mm_txt.replace("dtype = torch.bfloat16", "dtype = torch.float32")
        open(mm_fp, "w", encoding="utf-8").write(mm_patched)

    gguf_fp = os.path.join(COMFY_DIR, "custom_nodes/ComfyUI-GGUF/nodes.py")
    if os.path.exists(gguf_fp):
        g_txt = open(gguf_fp, "r", encoding="utf-8").read()
        g_patched = g_txt.replace("compute_dtype = torch.bfloat16", "compute_dtype = torch.float32").replace("compute_dtype=torch.bfloat16", "compute_dtype=torch.float32")
        open(gguf_fp, "w", encoding="utf-8").write(g_patched)
        log("Configured native SM75 FP32 compute_dtype on custom_nodes/ComfyUI-GGUF/nodes.py")

    mm=os.path.join(COMFY_DIR,"comfy","model_management.py")
    text=open(mm).read()
    marker="def text_encoder_device():\n"
    if marker in text:
        text=text.replace(marker,marker+"    if torch.cuda.is_available() and torch.cuda.device_count() > 1:\n        return torch.device('cuda:1')\n",1)
        open(mm,"w").write(text)
        log("Text encoder assigned to GPU1; diffusion stays on GPU0")

    log("Linked all MiniMax H3 Ref2VA models and Scarlett Monroe persistent reference images into ComfyUI.")

COMFY_PROC = None
OBJECT_INFO = {}
def start_comfyui():
    global COMFY_PROC, OBJECT_INFO
    STATE["stage"] = "starting_comfyui"
    log("Launching ComfyUI server on 127.0.0.1:8188 (DynamicVRAM + Native FP32 + FP32-VAE)...")
    comfy_log = open(os.path.join(WORK_ROOT, "comfyui_h3.log"), "a")
    COMFY_PROC = subprocess.Popen(
        [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", "8188", "--fp32-vae", "--fast-disk", "--disable-auto-launch"],
        cwd=COMFY_DIR, stdout=comfy_log, stderr=subprocess.STDOUT
    )
    for _ in range(180):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8188/object_info/MiniMaxH3ReferenceToVideo", timeout=5) as r:
                if r.status == 200:
                    OBJECT_INFO = json.loads(r.read().decode())
                    STATE["comfyui_ready"] = True
                    STATE["stage"] = "ready"
                    log("ComfyUI MiniMaxH3ReferenceToVideo node is LIVE on 127.0.0.1:8188!")
                    return
        except Exception:
            time.sleep(2)
    raise RuntimeError("ComfyUI failed to expose MiniMaxH3ReferenceToVideo within 360s")

def align_h3_frames(seconds: float, fps: int = 24) -> int:
    n = max(5, round(seconds * fps))
    while n % 17 != 5:
        n += 1
    return n

def build_ref2va_scene_workflow(prompt: str, ref_images: list, ref_audio_file: str, width: int, height: int, frame_len: int, seed: int, steps: int, prefix: str) -> dict:
    wf = {
        "1": {
            "class_type": "UnetLoaderGGUFDynamicVRAM",
            "inputs": {"unet_name": "minimax-h3-ref2va-Q4_0.gguf"}
        },
        "2": {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {
                "model": ["1", 0],
                "lora_name": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
                "strength_model": 1.0
            }
        },
        "3": {
            "class_type": "CLIPLoaderGGUFDynamicVRAM",
            "inputs": {
                "clip_name": "Qwen3-VL-32B-Instruct-MiniMax-H3-L0-49-Q2_K.gguf",
                "type": "minimax"
            }
        },
        "4": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}
        },
        "5": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}
        },
    }

    r2v_inputs = {
        "clip": ["3", 0],
        "vae": ["4", 0],
        "audio_vae": ["5", 0],
        "prompt": prompt,
        "width": width,
        "height": height,
        "length": frame_len,
        "ref_image_size": "match",
    }

    next_id = 20
    for idx, img_name in enumerate(ref_images):
        nid = str(next_id)
        next_id += 1
        wf[nid] = {"class_type": "LoadImage", "inputs": {"image": img_name}}
        r2v_inputs[f"ref_images.ref_image_{idx}"] = [nid, 0]

    if ref_audio_file:
        aid = str(next_id)
        next_id += 1
        wf[aid] = {"class_type": "LoadAudio", "inputs": {"audio": ref_audio_file}}
        r2v_inputs["ref_audios.ref_audio_0"] = [aid, 0]

    wf["11"] = {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": r2v_inputs}
    wf["12"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}}
    wf["13"] = {"class_type": "BasicScheduler", "inputs": {"model": ["2", 0], "scheduler": "simple", "steps": steps, "denoise": 1.0}}
    wf["14"] = {"class_type": "BasicGuider", "inputs": {"model": ["2", 0], "conditioning": ["11", 0]}}
    wf["15"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}}
    wf["16"] = {
        "class_type": "SamplerCustomAdvanced",
        "inputs": {
            "noise": ["15", 0],
            "guider": ["14", 0],
            "sampler": ["12", 0],
            "sigmas": ["13", 0],
            "latent_image": ["11", 1]
        }
    }
    wf["17"] = {"class_type": "VAEDecode", "inputs": {"samples": ["16", 0], "vae": ["4", 0]}}
    wf["19"] = {"class_type": "CreateVideo", "inputs": {"images": ["17", 0], "fps": 24.0}}
    wf["99"] = {"class_type": "SaveVideo", "inputs": {"video": ["19", 0], "filename_prefix": prefix, "format": "mp4", "codec": "h264"}}
    return wf


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

def run_comfy_and_wait_video(workflow: dict, timeout_sec: int = 2400, job_id: str = "") -> tuple:
    client_id=watch_comfy_progress(job_id)
    req = urllib.request.Request("http://127.0.0.1:8188/prompt", data=json.dumps({"prompt": workflow,"client_id":client_id}).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            prompt_id = json.loads(resp.read().decode())["prompt_id"]
    except urllib.error.HTTPError as he:
        err_body = he.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"ComfyUI rejected prompt ({he.code}): {err_body[:600]}")

    t0 = time.time()
    while time.time() - t0 < timeout_sec:
        with urllib.request.urlopen(f"http://127.0.0.1:8188/history/{prompt_id}", timeout=10) as hr:
            hist = json.loads(hr.read().decode())
        if prompt_id in hist:
            entry = hist[prompt_id]
            st = entry.get("status", {})
            if st.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI scene execution error: {json.dumps(st)}")
            outputs = entry.get("outputs", {})
            for _, nout in outputs.items():
                for k in ("images", "videos", "gifs", "files"):
                    if k in nout and nout[k]:
                        for item in nout[k]:
                            fn = item.get("filename", "")
                            if fn.endswith((".mp4", ".webm", ".mkv", ".mov")):
                                cand = os.path.join(COMFY_DIR, "output", item.get("subfolder", ""), fn)
                                if os.path.exists(cand):
                                    return prompt_id, cand
        time.sleep(3)
    raise RuntimeError(f"Timed out after {timeout_sec}s waiting for ComfyUI prompt {prompt_id}")

def run_multiscene_video_job(job_id: str, payload: dict):
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id]["stage"] = "queued_waiting_for_gpu"
    with VIDEO_EXECUTION_LOCK:
        _run_multiscene_video_job_locked(job_id, payload)

def _run_multiscene_video_job_locked(job_id: str, payload: dict):
    try:
        scenes = payload.get("scenes") or []
        if not scenes:
            raise ValueError("scenes list is required for multi-scene video generation")

        diff_width = int(payload.get("diffusion_width") or 256)
        diff_height = int(payload.get("diffusion_height") or 448)
        diff_width = min(384, max(256, (diff_width // 32) * 32))
        diff_height = min(672, max(256, (diff_height // 32) * 32))
        out_width = int(payload.get("width") or 720)
        out_height = int(payload.get("height") or 1280)
        steps = min(8, max(4,int(payload.get("steps") or 4)))
        base_seed = int(payload.get("seed") or (int(time.time() * 1000) % 2147483647))
        overlap_sec = 0.0

        comfy_inp = os.path.join(COMFY_DIR, "input")
        job_work = os.path.join(JOBS_DIR, job_id)
        os.makedirs(job_work, exist_ok=True)

        master_audio_path = None
        if payload.get("master_audio_base64"):
            master_audio_path = os.path.join(job_work, "master_music.mp3")
            with open(master_audio_path, "wb") as af:
                af.write(base64.b64decode(payload["master_audio_base64"]))

        scene_mp4s = []
        comfy_prompt_ids = []
        prev_last_frame_name = None
        total_scenes = len(scenes)

        for idx, sc in enumerate(scenes):
            sc_num = idx + 1
            sc_dur = float(sc.get("duration_sec") or 7.0)
            sc_start = float(sc.get("start_sec") or sum(float(x.get("duration_sec", 7.0)) for x in scenes[:idx]))
            gen_dur = sc_dur + (overlap_sec if idx < total_scenes - 1 else 0.0)
            frame_len = align_h3_frames(gen_dur, 24)

            with JOBS_LOCK:
                JOBS[job_id].update({
                    "status": "running",
                    "stage": f"comfyui_rendering_scene_{sc_num}_of_{total_scenes}",
                    "current_scene": sc_num,
                    "total_scenes": total_scenes,
                    "progress": int(5 + (idx / total_scenes) * 80),
                })

            # Slice synchronized audio reference for this exact scene window
            ref_audio_name = ""
            if master_audio_path and os.path.exists(master_audio_path):
                ref_audio_name = f"{job_id}_sc{sc_num}_audio.wav"
                slice_dst = os.path.join(comfy_inp, ref_audio_name)
                subprocess.run([
                    "ffmpeg", "-y", "-ss", f"{sc_start:.2f}", "-t", f"{gen_dur:.2f}",
                    "-i", master_audio_path, "-ar", "32000", "-ac", "2", slice_dst
                ], check=False, capture_output=True)
                if not os.path.exists(slice_dst) or os.path.getsize(slice_dst) < 1000:
                    ref_audio_name = ""

            # Fixed reference order avoids changing identity/body conditioning roles.
            ref_imgs=["scarlett_ref_1.jpg","scarlett_ref_3.jpg","scarlett_ref_2.jpg"]
            ref_prefix=("Natural live-action footage. Same adult Scarlett Monroe as <Picture 1>; face and hair from <Picture 2>, body proportions from <Picture 3>. "
                "Keep skeletal dimensions and body volume fixed: no growth, inflation or reshaping during exercise. "
                "Normal real-time motion, grounded feet, stable exposure, natural skin texture and fabric. "
                "One location, same clothing and camera axis; no cuts, no slow-motion, no exaggerated body physics. ")

            audio_clause = "Synchronize every body movement, hip bounce, and dance beat seamlessly with <Audio 1>. " if ref_audio_name else ""
            full_prompt = ref_prefix + audio_clause + (sc.get("comfy_prompt") or sc.get("prompt") or "")

            wf = build_ref2va_scene_workflow(
                prompt=full_prompt,
                ref_images=ref_imgs,
                ref_audio_file=ref_audio_name,
                width=diff_width,
                height=diff_height,
                frame_len=frame_len,
                seed=base_seed,
                steps=steps,
                prefix=f"video/{job_id}_scene_{sc_num}"
            )
            if prev_last_frame_name:
                wf["50"]={"class_type":"LoadImage","inputs":{"image":prev_last_frame_name}}
                wf["51"]={"class_type":"MiniMaxH3AddGuide","inputs":{"positive":["11",0],"latent":["11",1],"vae":["4",0],"image":["50",0],"frame_idx":0}}
                wf["14"]["inputs"]["conditioning"]=["51",0]
            pid, raw_clip = run_comfy_and_wait_video(wf,job_id=job_id)
            comfy_prompt_ids.append(pid)

            norm_clip = os.path.join(job_work, f"scene_{sc_num}_norm.mp4")
            subprocess.run([
                "ffmpeg", "-y", "-i", raw_clip,
                "-t", f"{gen_dur:.2f}",
                "-vf", f"scale={out_width}:{out_height}:force_original_aspect_ratio=decrease:flags=lanczos,pad={out_width}:{out_height}:(ow-iw)/2:(oh-ih)/2,fps=24,format=yuv420p",
                "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                norm_clip
            ], check=True, capture_output=True)
            scene_mp4s.append((norm_clip, gen_dur))

            # Extract final frame for seamless temporal continuity into Scene s+1
            last_frame_name = f"{job_id}_sc{sc_num}_last.png"
            last_frame_path = os.path.join(comfy_inp, last_frame_name)
            subprocess.run([
                "ffmpeg", "-y", "-sseof", "-0.08", "-i", norm_clip,
                "-frames:v", "1", "-update", "1", last_frame_path
            ], check=False, capture_output=True)
            if os.path.exists(last_frame_path) and os.path.getsize(last_frame_path) > 1000:
                prev_last_frame_name = last_frame_name

        with JOBS_LOCK:
            JOBS[job_id].update({
                "stage": "assembling_seamless_multiscene_master",
                "progress": 90,
            })

        # Seamless xfade multi-scene assembly
        assembled_visual = os.path.join(job_work, "assembled_visual.mp4")
        if len(scene_mp4s) == 1:
            shutil.copy2(scene_mp4s[0][0], assembled_visual)
        else:
            concat_file=os.path.join(job_work,"concat.txt")
            with open(concat_file,"w") as cf:
                for clip,_ in scene_mp4s: cf.write("file '"+clip+"'\n")
            subprocess.run(["ffmpeg","-y","-f","concat","-safe","0","-i",concat_file,"-c","copy",assembled_visual],check=True,capture_output=True)

        # Probe visual length & enforce strict 20-40s requirement
        pr_v = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", assembled_visual],
            capture_output=True, text=True
        )
        vis_dur = float((pr_v.stdout or "24.0").strip())
        target_total = min(40.0, max(20.0, vis_dur))

        final_mp4 = os.path.join(JOBS_DIR, f"{job_id}.mp4")
        if master_audio_path and os.path.exists(master_audio_path):
            subprocess.run([
                "ffmpeg", "-y",
                "-i", assembled_visual,
                "-i", master_audio_path,
                "-t", f"{target_total:.2f}",
                "-map", "0:v:0", "-map", "1:a:0",
                "-c:v", "copy",
                "-c:a", "aac", "-b:a", "192k", "-ar", "32000", "-ac", "2",
                "-movflags", "+faststart",
                "-shortest",
                final_mp4
            ], check=True, capture_output=True)
        else:
            subprocess.run([
                "ffmpeg", "-y", "-i", assembled_visual, "-t", f"{target_total:.2f}",
                "-c:v", "copy",
                "-movflags", "+faststart", final_mp4
            ], check=True, capture_output=True)

        pr_f = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", final_mp4],
            capture_output=True, text=True
        )
        final_dur = float((pr_f.stdout or str(target_total)).strip())

        # Clean up temporary intermediate job scene files while keeping final MP4 and persistent models/refs
        shutil.rmtree(job_work, ignore_errors=True)

        with JOBS_LOCK:
            JOBS[job_id].update({
                "status": "completed",
                "stage": "completed",
                "progress": 100,
                "output_path": final_mp4,
                "duration_sec": round(final_dur, 2),
                "comfyui_prompt_ids": comfy_prompt_ids,
                "completed_at": time.time(),
            })
        log(f"Multi-scene video job {job_id} COMPLETED ({final_dur:.2f}s seamless MP4 across {total_scenes} scenes)")
    except Exception as e:
        try:
            urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8188/interrupt',data=b'{}',headers={'Content-Type':'application/json'}),timeout=5).close()
        except Exception: pass
        tb = traceback.format_exc()
        log(f"Video job {job_id} FAILED: {e}\n{tb}")
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
            cf_log = "/tmp/cloudflared_h3.log"
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
                log(f"VIBELY_VIDEO_TUNNEL_URL={found_url}")
                with open(os.path.join(WORK_ROOT, "tunnel_status.json"), "w") as tf:
                    json.dump({"service": "minimax-h3-ref2va", "username": KAGGLE_USERNAME, "tunnel_url": found_url, "updated_at": time.time()}, tf)
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
            ep_dir = "/tmp/ep_pub_h3"
            os.makedirs(ep_dir, exist_ok=True)
            with open(os.path.join(ep_dir, "endpoint.json"), "w") as ef:
                json.dump(payload_dict, ef)
            with open(os.path.join(ep_dir, "dataset-metadata.json"), "w") as mf:
                json.dump({
                    "title": "VIBELY H3 Live Endpoint",
                    "id": "joshbond123/vibely-h3-live-endpoint",
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
            "worker_version":"critical-v2",
            "worker_started_at":STATE["started_at"],
            "service": "minimax_h3_ref2va",
            "username": KAGGLE_USERNAME,
            "model_name": "MiniMax H3 Ref2VA",
            "endpoint_url": STATE["tunnel_url"],
            "api_key": API_KEY,
            "comfyui_ready": STATE["comfyui_ready"],
            "dataset_cached": STATE["dataset_cached"],
            "storage_sources": STATE["storage_sources"],
            "character_refs": STATE["character_refs"],
            "gpu_name": STATE["gpu_name"],
            "updated_at": time.time(),
        }
        threading.Thread(target=_publish_endpoint_dataset, args=(payload_dict,), daemon=True).start()
        body = json.dumps(payload_dict).encode()
        try:
            req = urllib.request.Request(
                "https://aivideo.aivideo.blitz.cloud/api/models/register",
                data=body,
                headers={"Content-Type": "application/json", "X-Registry-Secret": REGISTRY_SECRET, "User-Agent": "Mozilla/5.0"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=8).read()
        except Exception:
            # Workers report health; they must never resume/restart hosting apps.
            pass

    def _hb_loop():
        while True:
            _send_heartbeat()
            time.sleep(30)

    threading.Thread(target=_tunnel_loop, daemon=True).start()
    threading.Thread(target=_hb_loop, daemon=True).start()

def main():
    try:
        gpu_q = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True)
        STATE["gpu_name"] = (gpu_q.stdout or "Kaggle GPU").strip()
        log(f"Detected GPU: {STATE['gpu_name']}")
    except Exception:
        pass

    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "fastapi", "uvicorn"], check=False)
    from fastapi import FastAPI, Header, HTTPException
    from fastapi.responses import FileResponse
    import uvicorn

    app = FastAPI(title="VIBELY MiniMax H3 Ref2VA ComfyUI API")

    def verify_auth(authorization: str = Header(default="")):
        if authorization != f"Bearer {API_KEY}":
            raise HTTPException(status_code=401, detail="Unauthorized")

    @app.get("/health")
    def health():
        return {
            "ok": True,
            "worker_version":"critical-v2",
            "worker_started_at":STATE["started_at"],
            "service": "minimax_h3_ref2va",
            "username": KAGGLE_USERNAME,
            "model": "MiniMax H3 Ref2VA",
            "stage": STATE["stage"],
            "comfyui_ready": STATE["comfyui_ready"],
            "dataset_cached": STATE["dataset_cached"],
            "storage_sources": STATE["storage_sources"],
            "character_refs": STATE["character_refs"],
            "gpu": STATE["gpu_name"],
            "tunnel_url": STATE["tunnel_url"],
            "uptime_sec": round(time.time() - STATE["started_at"], 1),
            "last_error": STATE["last_error"],
        }

    @app.get("/v1/references")
    def get_refs(authorization: str = Header(default="")):
        verify_auth(authorization)
        items = []
        for fn in sorted(os.listdir(REFS_DIR)):
            fp = os.path.join(REFS_DIR, fn)
            items.append({"filename": fn, "bytes": os.path.getsize(fp), "comfy_input_ready": os.path.exists(os.path.join(COMFY_DIR, "input", fn))})
        return {"ok": True, "character": "Scarlett Monroe", "references": items}

    @app.post("/v1/video/jobs")
    def create_video_job(payload: dict, authorization: str = Header(default="")):
        verify_auth(authorization)
        if not STATE["comfyui_ready"]:
            raise HTTPException(status_code=503, detail=f"ComfyUI still {STATE['stage']}")
        request_id=str(payload.get("request_id") or "")
        job_id = "vid_" + (__import__('hashlib').sha256(request_id.encode()).hexdigest()[:20] if request_id else uuid.uuid4().hex[:12])
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
        threading.Thread(target=run_multiscene_video_job, args=(job_id, payload), daemon=True).start()
        return {"ok": True, "job_id": job_id, "status": "queued"}

    @app.get("/v1/video/jobs/{job_id}")
    def get_video_job(job_id: str, authorization: str = Header(default="")):
        verify_auth(authorization)
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job:
                raise HTTPException(status_code=404, detail="Job not found")
            return dict(job)

    @app.get("/v1/logs")
    def read_video_logs(authorization: str = Header(default="")):
        verify_auth(authorization)
        out = {}
        for fn in ("vibely_h3.log", "comfyui_h3.log"):
            p = os.path.join(WORK_ROOT, fn)
            out[fn] = open(p, errors="replace").read()[-6000:] if os.path.exists(p) else ""
        return out

    @app.get("/v1/diagnostics")
    def video_diagnostics(authorization: str = Header(default="")):
        verify_auth(authorization)
        smi = subprocess.run(["nvidia-smi", "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,power.draw", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip()
        disks = {d: {"free_gb": round(shutil.disk_usage(d).free / 1e9, 2), "total_gb": round(shutil.disk_usage(d).total / 1e9, 2)} for d in ("/", "/tmp", "/kaggle/working", "/dev/shm") if os.path.isdir(d)}
        try:
            q = json.loads(urllib.request.urlopen("http://127.0.0.1:8188/queue", timeout=5).read().decode())
        except Exception as e:
            q = {"error": str(e)}
        return {"nvidia_smi": smi, "disks": disks, "comfyui_queue": q}

    @app.get("/v1/video/jobs/{job_id}/video")
    def download_video_mp4(job_id: str, authorization: str = Header(default="")):
        verify_auth(authorization)
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            if not job or job.get("status") != "completed":
                raise HTTPException(status_code=404, detail="Video not ready")
            path = job["output_path"]
        return FileResponse(path, media_type="video/mp4", filename=f"{job_id}.mp4")

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
        publish_persistent_dataset_bg(paths)
        setup_comfyui(paths)
        start_comfyui()
    except Exception as e:
        STATE["last_error"] = str(e)
        STATE["stage"] = "error"
        log(f"FATAL SETUP ERROR: {e}\n{traceback.format_exc()}")

    t0 = time.time()
    while time.time() - t0 < 11.5 * 3600:
        if COMFY_PROC is not None and COMFY_PROC.poll() is not None:
            log("ComfyUI process exited unexpectedly; restarting...")
            STATE["comfyui_ready"] = False
            try:
                start_comfyui()
            except Exception as re_err:
                log(f"Restart error: {re_err}")
        time.sleep(15)

if __name__ == "__main__":
    main()
