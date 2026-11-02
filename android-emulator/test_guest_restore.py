import ast,hashlib,struct,tempfile,unittest,zlib
from pathlib import Path
# Import only pure restore helpers: unit tests must never contact a live phone,
# GitHub, start a VM, or require production credentials.
source=Path(__file__).with_name('guest_disk_restore.py').read_text()
tree=ast.parse(source);helpers=ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'gpt','sparse_write','extract_range'}],type_ignores=[])
ns={'Path':Path,'struct':struct,'zlib':zlib,'os':__import__('os')};exec(compile(helpers,'helpers','exec'),ns)

class GuestRecoveryHelpers(unittest.TestCase):
 def fixture(self,path):
  entry=bytearray(128);entry[:16]=b'x'*16;struct.pack_into('<QQ',entry,32,40,47);name='metadata'.encode('utf-16-le');entry[56:56+len(name)]=name
  header=bytearray(512);header[:8]=b'EFI PART';struct.pack_into('<I',header,12,92);struct.pack_into('<Q',header,72,2);struct.pack_into('<III',header,80,1,128,zlib.crc32(entry));struct.pack_into('<I',header,16,zlib.crc32(header[:92]))
  data=bytearray(64*512);data[512:1024]=header;data[1024:1152]=entry;path.write_bytes(data)
 def test_gpt_original_partition_offsets(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'disk';self.fixture(p);self.assertEqual(ns['gpt'](p),{'metadata':(40*512,8*512)})
 def test_corruption_rejected(self):
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'disk';self.fixture(p);data=bytearray(p.read_bytes());data[1025]^=1;p.write_bytes(data)
   with self.assertRaises(ValueError):ns['gpt'](p)
 def test_sparse_partition_copy_preserves_all_bytes(self):
  with tempfile.TemporaryDirectory() as t:
   a=Path(t)/'a';b=Path(t)/'b';data=bytes(1048576)+b'not-zero'+bytes(1048576);a.write_bytes(b'header'+data+b'end');ns['extract_range'](a,b,6,len(data));self.assertEqual(hashlib.sha256(b.read_bytes()).digest(),hashlib.sha256(data).digest())

if __name__=='__main__':unittest.main()
