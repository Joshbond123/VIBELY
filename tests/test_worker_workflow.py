"""Structural regression tests, separate from mandatory live generation tests."""
import ast,pathlib,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
class WorkflowTests(unittest.TestCase):
 def test_model_frame_grid(self):
  tree=ast.parse((ROOT/'workers/video_worker.py').read_text())
  wanted=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('align_h3_frames','build_ref2va_scene_workflow')]
  ns={};exec(compile(ast.Module(body=wanted,type_ignores=[]),'workflow','exec'),ns)
  for sec in (1,5,7.33,22):
   n=ns['align_h3_frames'](sec);self.assertEqual(n%17,5);self.assertGreaterEqual(n,round(sec*24))
  w=ns['build_ref2va_scene_workflow']('real motion',['scarlett_ref_1.jpg','scarlett_ref_3.jpg','scarlett_ref_2.jpg'],'',320,576,175,42,4,'test')
  self.assertEqual(w['13']['inputs']['steps'],4)
  self.assertEqual(w['12']['inputs']['sampler_name'],'euler')
  self.assertEqual(w['11']['inputs']['ref_image_size'],'match')
  self.assertEqual(w['11']['inputs']['width'],320)
  self.assertEqual(w['19']['inputs']['fps'],24.0)
 def test_real_guide_not_crossfade(self):
  s=(ROOT/'workers/video_worker.py').read_text()
  self.assertIn('"class_type":"MiniMaxH3AddGuide"',s)
  self.assertNotIn('xfade=transition',s)
  self.assertNotIn('base_seed + idx',s)
  self.assertIn('guide_frames = 22 if prev_tail_video_name else 0',s)
  self.assertIn('trim=start_frame={guide_frames}',s)
  self.assertIn('\"class_type\":\"GetVideoComponents\"',s)
  self.assertNotIn('hip bounce, and dance beat',s)
 def test_worker_sources_have_no_credentials(self):
  import re
  for p in (ROOT/'workers').glob('*.py'):
   self.assertIsNone(re.search(r'(?:hf_|KGAT_|nvapi-|github_pat_|bc_)[A-Za-z0-9_-]{16,}',p.read_text()))
if __name__=='__main__':unittest.main()
