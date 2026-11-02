#!/usr/bin/env python3
"""Isolated offline restore of the explicitly approved guest-disk rescue.
Never registers with the public gateway or changes ownership. Not an official
Play migration; reconstructed host configuration and missing original host key
are explicit limitations of this emergency format.
"""
import hashlib,json,os,re,shutil,struct,subprocess,time,zlib,base64,concurrent.futures
from github_state import encrypt
from pathlib import Path
from github_state import Store,decrypt

ROOT=Path('/home/runner/guest-recovery');ROOT.mkdir(mode=0o700,exist_ok=True)
CACHE=ROOT/'encrypted';CACHE.mkdir(mode=0o700,exist_ok=True)
AVD=Path(os.environ['ANDROID_AVD_HOME'])/'vibely_pixel6_api34.avd'
SYSTEM=AVD/'recovered-system';SYSTEM.mkdir(mode=0o700,exist_ok=True)
CANDIDATE=os.environ.get('FORENSIC_CANDIDATE')=='true'
NS='vibely-isolated-recovery';store=Store();release_id=int(os.environ['RESCUE_RELEASE_ID'])

def emit(event,**kw):print(json.dumps({'event':event,**kw}),flush=True)
def run(*args,**kw):return subprocess.run(args,check=True,capture_output=True,timeout=kw.pop('timeout',120),**kw).stdout

def sparse_write(f,data):
 if data==bytes(len(data)):f.seek(len(data),1)
 else:f.write(data)

def gpt(path):
 with path.open('rb') as f:
  f.seek(512);h=f.read(512)
  if h[:8]!=b'EFI PART':raise ValueError('Missing original GPT')
  n=struct.unpack_from('<I',h,12)[0];wanted=struct.unpack_from('<I',h,16)[0]
  header=bytearray(h[:n]);header[16:20]=bytes(4)
  if n>512 or zlib.crc32(header)!=wanted:raise ValueError('Invalid GPT header CRC')
  lba=struct.unpack_from('<Q',h,72)[0];count,size,crc=struct.unpack_from('<III',h,80)
  if count*size>2097152 or size<128:raise ValueError('Unsafe GPT table')
  f.seek(lba*512);table=f.read(count*size)
  if zlib.crc32(table)!=crc:raise ValueError('Invalid GPT table CRC')
  result={}
  for i in range(count):
   entry=table[i*size:(i+1)*size]
   if entry[:16]==bytes(16):continue
   first,last=struct.unpack_from('<QQ',entry,32);label=entry[56:128].decode('utf-16-le').rstrip('\0')
   if first>last or (last+1)*512>path.stat().st_size:raise ValueError('GPT bounds')
   result[label]=(first*512,(last-first+1)*512)
  return result

def extract_range(src,dest,start,size):
 with src.open('rb') as a,dest.open('wb') as b:
  a.seek(start);left=size
  while left:
   block=a.read(min(left,8*1024*1024))
   if not block:raise ValueError('Short partition')
   sparse_write(b,block);left-=len(block)
  b.truncate(size)
 os.chmod(dest,0o600)

# Prefetch encrypted assets while the source is still capturing. Never boot or
# trust draft data: the authenticated published manifest is the acceptance gate.
for _ in range(480):
 release=store.api('GET','/releases/'+str(release_id))
 dependencies=store.api('GET','/releases/431560693')['assets']
 def prefetch(a):
  if not a['name'].endswith('.gcm'):return
  p=CACHE/str(a['id'])
  if p.exists():return
  if not a.get('digest'):raise ValueError('Missing encrypted asset digest')
  descriptor={'id':a['id'],'name':a['name'],'bytes':a['size'],'sha256':a['digest'].split(':')[-1]}
  p.write_bytes(store.download_asset(descriptor));os.chmod(p,0o600)
 with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:list(pool.map(prefetch,release['assets']+dependencies))
 if CANDIDATE and any(a['name']=='candidate-manifest.gcm' for a in release['assets']):break
 if not CANDIDATE and not release['draft']:break
 time.sleep(10)
else:raise RuntimeError('Verified rescue publication deadline exceeded')
ma=next(a for a in release['assets'] if a['name']==('candidate-manifest.gcm' if CANDIDATE else 'manifest.gcm'));cipher=(CACHE/str(ma['id'])).read_bytes();manifest=json.loads(decrypt(cipher,store.password))
meta=manifest['metadata']
if meta['source_session']!='emu_41424314059_c4be3a':raise ValueError('Wrong source')
if CANDIDATE:
 if not manifest.get('forensic_candidate_only') or manifest['source_and_download_hashes_match'] is not False:raise ValueError('Not explicitly untrusted forensic candidate')
 emit('UNTRUSTED_CANDIDATE_OFFLINE_ONLY',source_mismatches=manifest['original_source_hash_mismatches'])
elif not manifest['source_and_download_hashes_match']:raise ValueError('Unverified source')
if meta['format']!='guest-disks-v1-NOT-FULL-AVD' or meta['account_count']<1:raise ValueError('Not an approved signed-in rescue')
emit('CANDIDATE_CIPHERTEXT_AUTHENTICATED' if CANDIDATE else 'PUBLISHED_RESCUE_AUTHENTICATED',source_session=meta['source_session'])
for v in manifest['volumes']:
 raw=ROOT/(v['device']+'.raw');whole=hashlib.sha256();total=0
 with raw.open('wb') as f:
  for part in v['parts']:
   a=part['asset'];p=CACHE/str(a['id'])
   if not p.exists():p.write_bytes(store.download_asset(a))
   blob=p.read_bytes()
   if hashlib.sha256(blob).hexdigest()!=a['sha256'] or len(blob)!=a['bytes']:raise ValueError('Encrypted asset digest mismatch')
   data=decrypt(blob,store.password);offset=0;ph=hashlib.sha256();pn=0
   import gzip
   while offset<len(data):
    n=struct.unpack_from('<I',data,offset)[0];offset+=4
    if n>16*1024*1024 or offset+n>len(data):raise ValueError('Record bounds')
    block=gzip.decompress(data[offset:offset+n]);offset+=n
    whole.update(block);ph.update(block);total+=len(block);pn+=len(block);sparse_write(f,block)
   if ph.hexdigest()!=part['raw_sha256'] or pn!=part['raw_bytes']:raise ValueError('Part plaintext integrity mismatch')
   p.unlink() # GitHub remains authoritative; avoid holding ciphertext plus plaintext copies.
  f.truncate(total)
 if total!=v['bytes'] or whole.hexdigest()!=v['sha256']:raise ValueError('Whole volume integrity mismatch')
 d=v['device']
 if d in ('vda','vdd','vde'):
  partitions=gpt(raw)
  expected={'vda':{'vbmeta','super'},'vdd':{'metadata'},'vde':{'vendor'}}[d]
  if set(partitions)!=expected:raise ValueError('Unexpected original disk layout')
  for name,(start,size) in partitions.items():
   target={'super':SYSTEM/'system.img','vbmeta':SYSTEM/'vbmeta.img','metadata':AVD/'encryptionkey.img','vendor':SYSTEM/'vendor.img'}[name]
   extract_range(raw,target,start,size)
  raw.unlink()
 else:os.replace(raw,AVD/{'vdb':'cache.img','vdc':'userdata-qemu.img','vdf':'sdcard.img'}[d])
 emit('ORIGINAL_VOLUME_RECONSTRUCTED',device=d)
# Copy only platform boot files. Original system/vendor/vbmeta payloads above
# remain authoritative; SDK blank userdata is never booted or substituted.
sdk=Path(os.environ['ANDROID_HOME'])/'system-images/android-34/google_apis/x86_64'
for name in ['kernel-ranchu','ramdisk.img','source.properties','advancedFeatures.ini','VerifiedBootParams.textproto']:
 if (sdk/name).is_file():shutil.copyfile(sdk/name,SYSTEM/name)
config=AVD/'config.ini';lines=config.read_text().splitlines();overrides={'image.sysdir.1':str(SYSTEM)+'/', 'disk.systemPartition.initPath':str(SYSTEM/'system.img'),'disk.vendorPartition.initPath':str(SYSTEM/'vendor.img'),'disk.dataPartition.size':'6144M','hw.lcd.width':'1080','hw.lcd.height':'2400','hw.lcd.density':'420','hw.ramSize':'4096','hw.cpu.ncore':'4','hw.keyboard':'yes'}
config.write_text('\n'.join(x for x in lines if x.split('=',1)[0] not in overrides)+'\n'+'\n'.join(k+'='+v for k,v in overrides.items())+'\n')
run('sudo','ip','netns','add',NS);run('sudo','ip','-n',NS,'link','set','lo','up')
# There is deliberately no namespace uplink/default route: candidate cannot
# refresh Google tokens or act as a duplicate network writer before ownership.
prefix=['sudo','ip','netns','exec',NS,'sudo','-u',os.environ['USER'],'env','HOME='+str(Path.home()),'ANDROID_HOME='+os.environ['ANDROID_HOME'],'ANDROID_AVD_HOME='+os.environ['ANDROID_AVD_HOME'],'PATH='+os.environ['PATH']]
log=(ROOT/'emulator.log').open('wb')
cmd=['emulator','-avd','vibely_pixel6_api34','-no-window','-no-audio','-no-boot-anim','-no-snapshot','-gpu','swiftshader_indirect','-memory','4096','-cores','4','-system',str(SYSTEM/'system.img'),'-vendor',str(SYSTEM/'vendor.img'),'-data',str(AVD/'userdata-qemu.img'),'-cache',str(AVD/'cache.img'),'-sdcard',str(AVD/'sdcard.img'),'-encryption-key',str(AVD/'encryptionkey.img')]
run(*(prefix+['adb','start-server']))
proc=subprocess.Popen(prefix+cmd,stdout=log,stderr=subprocess.STDOUT)
def adb(*args):return run(*(prefix+['adb',*args]),timeout=60).decode(errors='replace').strip()
def console(*args):return run(*(prefix+['adb','-s','emulator-5554','emu',*args]),timeout=20)
def diagnostic(label):
 info={'label':label,'emulator_log':(ROOT/'emulator.log').read_text(errors='replace'),'adb_devices':adb('devices','-l')}
 shot=ROOT/'native-console.png'
 try:
  console('screenrecord','screenshot',str(shot))
  if shot.exists():info['native_screenshot_png_base64']=base64.b64encode(shot.read_bytes()).decode()
 except Exception as e:info['console_error']=type(e).__name__
 store.upload_asset(release,'private-diagnostic-'+os.environ['GITHUB_RUN_ID']+'-'+label+'.gcm',encrypt(json.dumps(info).encode(),store.password))
 emit('PRIVATE_NATIVE_DIAGNOSTIC_UPLOADED',label=label)
 return shot
consent_attempted=False
try:
 for attempt in range(100):
  if proc.poll() is not None:raise RuntimeError('Restored emulator exited; inspect private runner log')
  try:
   if adb('shell','getprop sys.boot_completed')=='1':break
  except subprocess.CalledProcessError:pass
  if attempt in (8,35):
   shot=diagnostic(str(attempt))
   devices=adb('devices','-l')
   emit('NATIVE_ADB_STATE',unauthorized='unauthorized' in devices,offline='offline' in devices)
   if 'unauthorized' in devices and shot.exists() and not consent_attempted:
    # Normal on-screen authorization of this clone's new host key. Never edit
    # adb_keys, disable authorization, clear a credential, or bypass lockscreen.
    ocr=run('tesseract',str(shot),'stdout',timeout=30).decode(errors='replace')
    if 'allow usb debugging' in ocr.lower():
     consent_attempted=True
     console('event','send','EV_KEY:KEY_RIGHT:1','EV_KEY:KEY_RIGHT:0','EV_SYN:SYN_REPORT:0')
     console('event','send','EV_KEY:KEY_ENTER:1','EV_KEY:KEY_ENTER:0','EV_SYN:SYN_REPORT:0')
     emit('NORMAL_VISIBLE_USB_DEBUGGING_CONSENT_ATTEMPTED')
  time.sleep(4)
 else:
  diagnostic('boot-deadline')
  raise RuntimeError('Restored boot/normal ADB authorization deadline exceeded; no bypass attempted')
 if adb('shell','getprop ro.build.fingerprint')!=meta['fingerprint']:raise ValueError('Original platform fingerprint not preserved')
 dump=adb('shell','dumpsys account');accounts='\n'.join(sorted(re.findall(r'^\s*Account \{name=([^}]+)\}\s*$',dump,re.M)))
 counts=re.findall(r'^\s*Accounts:\s*(\d+)\s*$',dump,re.M)
 if sum(map(int,counts))!=meta['account_count'] or hashlib.sha256(accounts.encode()).hexdigest()!=meta['account_hash']:raise ValueError('Original signed-in account rows not restored')
 adb('shell','am start -a android.intent.action.MAIN -c android.intent.category.HOME')
 from PIL import Image,ImageStat
 import io
 frame=run(*(prefix+['adb','exec-out','screencap','-p']),timeout=60);im=Image.open(io.BytesIO(frame)).convert('RGB');stats=ImageStat.Stat(im)
 if max(stats.mean)<2 or max(stats.stddev)<1:raise ValueError('Restored native display black')
 evidence={'native_boot':True,'original_platform':True,'whole_volume_hashes':not CANDIDATE,'candidate_ciphertext_and_plaintext_hashes':True,'forensic_candidate':CANDIDATE,'account_count':meta['account_count'],'account_rows_match':True,'display':True,'isolated_offline':True,'google_online_authentication_tested':False,'original_host_private_adb_key_available':False,'public_phone_replaced':False,'official_play_image':False}
 (ROOT/'restore-evidence.json').write_text(json.dumps(evidence,indent=2));emit('PASS_ISOLATED_ORIGINAL_GUEST_RESTORE',**evidence)
 # The recovered AVD embeds the original system/vendor. Drop duplicate SDK
 # payloads only AFTER a successful native boot; keep version evidence/boot files.
 for name in ['system.img','vendor.img','userdata.img']:(sdk/name).unlink(missing_ok=True)
 # Promote the reconstructed clone to a genuine whole-AVD/RAM checkpoint for
 # independent restore testing. This is a recovery branch, not production owner.
 archive=ROOT/'whole-avd.tar.zst';run(*(prefix+['env','ANDROID_CHECKPOINT_IMAGE_FAMILY=google_apis','python3','android-emulator/avd_checkpoint.py','capture','--avd',str(AVD),'--archive',str(archive)]),timeout=1800)
 metadata=json.loads(Path(str(archive)+'.json').read_text());metadata['recovered_from_guest_rescue']=release_id;metadata['google_online_authentication_tested']=False;metadata['forensic_recovery']=CANDIDATE;metadata['original_source_whole_hashes_match']=manifest['source_and_download_hashes_match'];metadata['latest_writes_preserved']=False
 store.initialize('recovered-source:'+os.environ['GITHUB_RUN_ID'])
 cp=store.publish(archive,'recovered-source:'+os.environ['GITHUB_RUN_ID'],metadata);(ROOT/'whole-checkpoint.json').write_text(json.dumps(cp));emit('RECOVERED_FULL_AVD_PUBLISHED',release_id=cp['release_id'])
finally:
 try:adb('emu','kill')
 except Exception:proc.terminate()
