"""Safety guard unit tests. These are NOT substitutes for live Kaggle lifecycle tests."""
import ast,pathlib,threading,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
class Rejected(Exception):
 def __init__(self,status_code,detail):self.status_code=status_code;self.detail=detail
class SafetyTests(unittest.TestCase):
 def test_shutdown_refuses_running_queued_and_unsaved_outputs(self):
  tree=ast.parse((ROOT/'workers/music_worker.py').read_text());fn=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='shutdown_worker');fn.decorator_list=[]
  for state in ['queued','running','completed']:
   ns={'Header':lambda **k:'','verify_auth':lambda token:None,'HTTPException':Rejected,'JOBS_LOCK':threading.Lock(),'JOBS':{'real-job':{'status':state}},'SHUTDOWN_REQUESTED':threading.Event(),'STATE':{}}
   exec(compile(ast.Module(body=[fn],type_ignores=[]),'shutdown-guard','exec'),ns)
   with self.assertRaises(Rejected) as err:ns['shutdown_worker']({},'test')
   self.assertEqual(err.exception.status_code,409);self.assertFalse(ns['SHUTDOWN_REQUESTED'].is_set())
 def test_observation_does_not_start_gpu(self):
  s=(ROOT/'src/server/gpuLifecycle.ts').read_text().split('export async function gpuDashboard()')[1]
  self.assertNotIn('acquireGpu(',s);self.assertNotIn('dispatchWorker(',s)
 def test_shutdown_is_confirmed_not_assumed(self):
  s=(ROOT/'src/server/gpuLifecycle.ts').read_text();self.assertIn('SESSION_TERMINATED',s);self.assertIn('kernels/status',s);self.assertIn("SET state='STOPPING'",s)
if __name__=='__main__':unittest.main()
