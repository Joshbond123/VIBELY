"""Worker HTTP protocol regression only; not GPU or media acceptance."""
import ast
import io
import json
import pathlib
import types
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class HttpTests(unittest.TestCase):
    def function(self, body):
        source = ast.parse((ROOT / 'workers/video_worker.py').read_text())
        fn = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'http')
        fake_request = types.SimpleNamespace(Request=lambda *a, **k: object(),
                                            urlopen=lambda *a, **k: io.BytesIO(body))
        ns = {'json': json, 'urllib': types.SimpleNamespace(request=fake_request)}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), 'worker-http', 'exec'), ns)
        return ns['http']

    def test_empty_comfy_success(self):
        self.assertEqual(self.function(b'')('http://unused/free', {'free_memory': True}), {})
        self.assertEqual(self.function(b'  ')('http://unused/history', {'clear': True}), {})

    def test_json_status_and_invalid_json(self):
        self.assertEqual(self.function(b'{"prompt_id":"real-id"}')('http://unused/prompt', {}),
                         {'prompt_id': 'real-id'})
        with self.assertRaises(json.JSONDecodeError):
            self.function(b'not json')('http://unused/prompt', {})


if __name__ == '__main__':
    unittest.main()
