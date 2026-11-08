"""External watch/handoff control-flow tests, not live hosting acceptance."""
import os
import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'tools'))
import watch_website


class Response:
    status = 204
    def __enter__(self): return self
    def __exit__(self, *args): return False


class WatchTests(unittest.TestCase):
    def test_bounded_watch_hands_off_only_website(self):
        clock = [0]
        checks = []
        requests = []
        def sleep(seconds): clock[0] += seconds
        def open_url(request, timeout):
            requests.append(request)
            return Response()
        with patch.dict(os.environ, {'WATCH_MINUTES': '1', 'GITHUB_TOKEN': 'unit-only',
                                     'GITHUB_REPOSITORY': 'Joshbond123/VIBELY'}), \
             patch.object(watch_website.time, 'monotonic', lambda: clock[0]), \
             patch.object(watch_website.time, 'sleep', sleep), \
             patch.object(watch_website, 'check_website', lambda: checks.append(True) or 0), \
             patch.object(watch_website.urllib.request, 'urlopen', open_url):
            watch_website.main()
        self.assertEqual(clock[0], 60)
        self.assertEqual(len(checks), 1)
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].full_url,
            'https://api.github.com/repos/Joshbond123/VIBELY/actions/workflows/keep-website-awake.yml/dispatches')
        self.assertNotIn('android', requests[0].full_url)


if __name__ == '__main__': unittest.main()
