"""Bounded ranged transfer with full artifact verification; no model execution."""
import concurrent.futures,hashlib,os,pathlib,time,urllib.request,urllib.error

def download_verified_ranges(url,destination,size,sha256,workers=4,chunk_bytes=128*1024*1024):
 if size<=0 or len(sha256)!=64 or workers<1 or workers>4:raise ValueError('Invalid artifact transfer contract')
 dest=pathlib.Path(destination);fd=os.open(dest,os.O_RDWR|os.O_CREAT|os.O_TRUNC,0o600);os.ftruncate(fd,size)
 def copy_range(start):
  end=min(size-1,start+chunk_bytes-1)
  for attempt in range(3):
   try:
    request=urllib.request.Request(url,headers={'Range':f'bytes={start}-{end}','Accept-Encoding':'identity'})
    with urllib.request.urlopen(request,timeout=90) as response:
     if response.status!=206 or response.headers.get('Content-Range')!=f'bytes {start}-{end}/{size}':raise RuntimeError('Server did not honor exact bounded byte range')
     offset=start
     while offset<=end:
      data=response.read(min(8*1024*1024,end-offset+1))
      if not data:raise RuntimeError('Truncated range transfer')
      view=memoryview(data)
      while view:
       written=os.pwrite(fd,view,offset)
       if written<=0:raise RuntimeError('Artifact write failed')
       view=view[written:];offset+=written
    return end-start+1
   except urllib.error.HTTPError as error:
    if error.code in (401,403) or attempt==2:raise RuntimeError(f'Artifact range HTTP {error.code}') from None
   except Exception:
    if attempt==2:raise
   time.sleep(attempt+1)
 executor=concurrent.futures.ThreadPoolExecutor(max_workers=workers)
 try:
  pending=[executor.submit(copy_range,start) for start in range(0,size,chunk_bytes)];done=0
  for future in concurrent.futures.as_completed(pending):
   done+=future.result()
   if done//(512*1024*1024)!=(done-future.result())//(512*1024*1024):print('Downloaded bytes (full SHA pending)',done,'of',size,flush=True)
  os.fsync(fd)
 finally:
  executor.shutdown(wait=True,cancel_futures=True);os.close(fd)
 digest=hashlib.sha256()
 with dest.open('rb') as f:
  for data in iter(lambda:f.read(8*1024*1024),b''):digest.update(data)
 if dest.stat().st_size!=size or digest.hexdigest()!=sha256:raise RuntimeError('Completed artifact SHA256 mismatch; refusing publication')
 return dest
