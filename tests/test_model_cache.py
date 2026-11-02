import dataclasses,hashlib,pathlib,sys,tempfile,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'workers'))
from verified_model_cache import ModelArtifact,verify_artifact
class CacheTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.p=pathlib.Path(self.tmp.name)/'weights.bin';self.p.write_bytes(b'abc');self.a=ModelArtifact('test/model','a'*40,'weights.bin',3,hashlib.sha256(b'abc').hexdigest())
 def tearDown(self):self.tmp.cleanup()
 def test_exact_authenticated_artifact(self):self.assertEqual(verify_artifact(self.p,self.a)['bytes'],3)
 def test_rejects_truncation(self):
  self.p.write_bytes(b'ab')
  with self.assertRaises(ValueError):verify_artifact(self.p,self.a)
 def test_rejects_same_size_corruption(self):
  verify_artifact(self.p,self.a);self.p.write_bytes(b'xyz')
  with self.assertRaises(ValueError):verify_artifact(self.p,self.a)
 def test_requires_immutable_pin(self):
  with self.assertRaises(ValueError):verify_artifact(self.p,dataclasses.replace(self.a,revision='main'))
 def test_rejects_traversal(self):
  with self.assertRaises(ValueError):verify_artifact(self.p,dataclasses.replace(self.a,filename='../weights'))
if __name__=='__main__':unittest.main()
