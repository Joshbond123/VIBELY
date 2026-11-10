"""Static regression checks for completion bookkeeping, not media acceptance."""
import pathlib
import unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]

class CompletionGuards(unittest.TestCase):
    def test_counter_matches_schema(self):
        source=(ROOT/'src/server/ltxVideoPipeline.ts').read_text()
        schema=(ROOT/'src/server/db.ts').read_text()
        self.assertIn('completed_count INTEGER',schema)
        self.assertIn('completed_count=completed_count+1',source)
        self.assertNotIn('success_count=success_count+1',source)

    def test_atomic_completion_and_late_error_protection(self):
        source=(ROOT/'src/server/ltxVideoPipeline.ts').read_text()
        self.assertIn('WITH finished AS (',source)
        self.assertIn("status<>'completed' RETURNING id",source)
        self.assertIn('if(failed.length)',source)

if __name__=='__main__':unittest.main()
