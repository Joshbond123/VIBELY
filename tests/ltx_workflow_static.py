"""Static graph checks only; not a GPU render or UI acceptance test."""
import ast,pathlib
source=pathlib.Path(__file__).parents[1].joinpath('workers/video_worker.py').read_text();tree=ast.parse(source)
spec=next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='MODEL_SPECS' for t in n.targets))
fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='workflow');scope={'MODEL_SPECS':ast.literal_eval(spec.value)}
exec(compile(ast.Module(body=[fn],type_ignores=[]),'LTX_static_graph','exec'),scope)
for frames in [24,96,97,100,120,121]:
 w=scope['workflow']({'id':'static_graph_check','frames':frames,'prompt':'Static graph input'},'reference.png')
 assert w['8']['inputs']['length']>=frames
 assert (w['8']['inputs']['length']-1)%8==0
 assert w['16']['inputs']['cfg']==1.0
 assert len(w['18']['inputs']['sigmas'].split(','))==9
 assert w['13']['inputs']['frames_number']==w['8']['inputs']['length']
 assert w['14']['class_type']=='LTXVConcatAVLatent'
 assert w['20']['class_type']=='LTXVSeparateAVLatent'
 assert not any('H3' in n['class_type'] or 'Lora' in n['class_type'] for n in w.values())
 for node in w.values():
  for v in node['inputs'].values():
   if isinstance(v,list):assert v[0] in w
assert len(scope['MODEL_SPECS'])==5
assert all(s.get('sha256') and s.get('revision') for s in scope['MODEL_SPECS'])
print('Static LTX graph checks passed. No GPU or UI execution performed.')
