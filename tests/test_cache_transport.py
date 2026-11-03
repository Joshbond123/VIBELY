"""Network transport unit fixtures, NOT GPU/model-installation acceptance."""
import sys,pathlib,tempfile,unittest,hashlib,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'workers'))
from cache_transport import download_verified_ranges
DATA=bytes(range(256))*1024
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_GET(self):
  start,end=map(int,self.headers['Range'][6:].split('-'));piece=DATA[start:end+1]
  self.send_response(206);self.send_header('Content-Range',f'bytes {start}-{end}/{len(DATA)}');self.send_header('Content-Length',str(len(piece)));self.end_headers();self.wfile.write(piece)
class Tests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
 @classmethod
 def tearDownClass(cls):cls.server.shutdown();cls.server.server_close()
 def test_verified_ranges(self):
  with tempfile.TemporaryDirectory() as t:
   p=pathlib.Path(t)/'transport-fixture.part';download_verified_ranges(f'http://127.0.0.1:{self.server.server_port}',p,len(DATA),hashlib.sha256(DATA).hexdigest(),chunk_bytes=32768);self.assertEqual(p.read_bytes(),DATA)
 def test_wrong_hash_rejected(self):
  with tempfile.TemporaryDirectory() as t:
   with self.assertRaisesRegex(RuntimeError,'SHA256 mismatch'):download_verified_ranges(f'http://127.0.0.1:{self.server.server_port}',pathlib.Path(t)/'bad.part',len(DATA),'0'*64,chunk_bytes=32768)
 def test_contract_rejected(self):
  with self.assertRaises(ValueError):download_verified_ranges('http://unused','unused',-1,'0'*64)
if __name__=='__main__':unittest.main()
