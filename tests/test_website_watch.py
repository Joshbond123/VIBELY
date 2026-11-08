"""External watch/handoff control-flow tests, not live hosting acceptance."""
import os
import io
import json
import pathlib
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'tools'))
import watch_website
import keep_website_awake


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


class ResumeTests(unittest.TestCase):
    def test_running_starting_capacity_states_are_not_restarted(self):
        for status in ['online', 'starting', 'attention']:
            self.check_state(status, False, False)
        self.check_state('sleeping', True, True)

    def check_state(self, status, asleep, expected):
        calls = []
        class RpcResponse(io.BytesIO):
            headers = {}
        def open_url(request, timeout):
            message = json.loads(request.data)
            if message['method'] == 'tools/call':
                name = message['params']['name']
                calls.append(name)
                self.assertEqual(message['params']['arguments']['app'], keep_website_awake.WEBSITE_APP)
                if name == 'apps_get':
                    state = {'status': status, 'asleep': asleep}
                    return RpcResponse(json.dumps({'result': {'content': [{'type': 'text', 'text': json.dumps(state)}]}}).encode())
            return RpcResponse(b'{"result":{}}')
        with patch.object(keep_website_awake.urllib.request, 'urlopen', open_url):
            result = keep_website_awake.resume_website('unit-only', keep_website_awake.WEBSITE_APP)
        self.assertEqual(result, expected)
        self.assertEqual('apps_resume' in calls, expected)


if __name__ == '__main__': unittest.main()

# Native resume gating is deliberately tested separately from HTTP health.
