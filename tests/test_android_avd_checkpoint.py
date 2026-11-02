import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('avd',Path(__file__).parents[1]/'android-emulator/avd_checkpoint.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class CaptureSafety(unittest.TestCase):
    def test_failed_copy_releases_even_final_hold(self):
        with tempfile.TemporaryDirectory() as tmp:
            avd=Path(tmp)/'phone.avd';avd.mkdir();(avd/'config.ini').touch();(avd/'userdata-qemu.img').touch()
            calls=[]
            def console(*args):
                calls.append(args)
                return 'virtual device is stopped\nOK' if args==('avd','status') else 'OK'
            def run(*args,**kwargs):
                if args[0]=='cp':raise OSError('injected disk copy failure')
                return b''
            with patch.object(m,'guest_evidence',return_value={'boot':True}),patch.object(m,'sdk_evidence',return_value={}),patch.object(m,'adb'),patch.object(m,'console',side_effect=console),patch.object(m,'run',side_effect=run):
                with self.assertRaises(OSError):m.capture(avd,Path(tmp)/'archive.zst',hold=True)
            self.assertIn(('avd','start'),calls)
            self.assertFalse((Path(tmp)/'archive.zst').exists())
    def test_running_vm_copy_refused_and_resumed(self):
        with tempfile.TemporaryDirectory() as tmp:
            avd=Path(tmp)/'phone.avd';avd.mkdir();(avd/'config.ini').touch();(avd/'userdata-qemu.img').touch()
            calls=[]
            def console(*args):
                calls.append(args);return 'running\nOK' if args==('avd','status') else 'OK'
            with patch.object(m,'guest_evidence',return_value={'boot':True}),patch.object(m,'sdk_evidence',return_value={}),patch.object(m,'adb'),patch.object(m,'console',side_effect=console),patch.object(m,'run') as copy:
                with self.assertRaises(RuntimeError):m.capture(avd,Path(tmp)/'archive.zst')
                copy.assert_not_called()
            self.assertIn(('avd','start'),calls)

if __name__=='__main__':unittest.main()

class CanonicalEvidence(unittest.TestCase):
    def test_permission_object_ids_and_diagnostic_history_do_not_change_grants(self):
        a='''  Package [org.test] (abc123):
    User 0: installed=true
      runtime permissions:
        android.permission.CAMERA: granted=true, flags=[ USER_SET|USER_SENSITIVE_WHEN_GRANTED]
'''
        b=a.replace('abc123','fffff').replace('USER_SET|USER_SENSITIVE_WHEN_GRANTED','USER_SENSITIVE_WHEN_GRANTED|USER_SET')
        self.assertEqual(m.canonical_permissions(a),m.canonical_permissions(b))
        self.assertNotEqual(m.canonical_permissions(a),m.canonical_permissions(b.replace('granted=true','granted=false')))
