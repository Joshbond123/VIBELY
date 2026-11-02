import importlib.util
from pathlib import Path
import tempfile
import unittest
from cryptography.exceptions import InvalidTag
spec=importlib.util.spec_from_file_location('state',Path(__file__).parents[1]/'android-emulator/github_state.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class FakeStore(m.Store):
    def __init__(self):
        self.password='test-only-'+('a'*40)
        self.state={'generation':0,'owner':'A','current':None,'previous':None,'pending':None}
        self.head='0';self.assets={};self.release=0;self.fail_upload=False
    def read(self):
        import copy
        return self.head,copy.deepcopy(self.state)
    def cas(self,old,state):
        if old!=self.head:raise m.Conflict('stale writer')
        self.state=state;self.head=str(int(self.head)+1)
    def api(self,method,path,**kw):
        if method=='POST' and path=='/releases':
            self.release+=1;return {'id':self.release,'upload_url':'unused'}
        return {}
    def upload_asset(self,release,name,content):
        if self.fail_upload:raise RuntimeError('injected upload failure')
        i=len(self.assets)+1;self.assets[i]=content
        return {'id':i,'name':name,'sha256':m.digest(content),'bytes':len(content)}
    def download_asset(self,asset):
        d=self.assets[asset['id']]
        if m.digest(d)!=asset['sha256']:raise ValueError('checksum')
        return d

class Tests(unittest.TestCase):
    def test_encryption_roundtrip_and_tamper(self):
        raw=b'private-google-token-example'*100
        encrypted=m.encrypt(raw,'a'*40)
        self.assertNotIn(raw[:20],encrypted)
        self.assertEqual(m.decrypt(encrypted,'a'*40),raw)
        with self.assertRaises(InvalidTag):m.decrypt(encrypted[:-1]+bytes([encrypted[-1]^1]),'a'*40)
        with self.assertRaises(InvalidTag):m.decrypt(encrypted,'b'*40)
    def test_atomic_failed_upload_and_fallback(self):
        store=FakeStore()
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'archive';p.write_bytes(b'first-private-disk'*100)
            first=store.publish(p,'A',{},part_bytes=1024)
            store.fail_upload=True
            with self.assertRaises(RuntimeError):store.publish(p,'A',{},part_bytes=1024)
            self.assertEqual(store.state['current'],first)
            store.fail_upload=False;p.write_bytes(b'second-disk'*100)
            second=store.publish(p,'A',{},part_bytes=1024)
            store.assets[second['manifest']['id']]=b'corrupt'
            out=Path(t)/'restored';r=store.restore(out)
            self.assertTrue(r['fallback_used']);self.assertEqual(out.read_bytes(),b'first-private-disk'*100)
    def test_single_writer_and_candidate_verification(self):
        s=FakeStore()
        with self.assertRaises(m.Conflict):s.owner('B')
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'disk';p.write_bytes(b'disk');cp=s.publish(p,'A',{'source_held':True})
            s.prepare('A','B',source_held=True)
            with self.assertRaises(ValueError):s.promote('B',cp,{'boot':True})
            self.assertEqual(s.state['owner'],'A')
            proof={k:True for k in ['boot','display','packages','account_hash','settings','userdata','foreground']}
            s.promote('B',cp,proof)
            self.assertEqual(s.state['owner'],'B')
            with self.assertRaises(m.Conflict):s.owner('A')
    def test_prewarm_cannot_promote_unheld_source(self):
        s=FakeStore()
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'disk';p.write_bytes(b'disk');cp=s.publish(p,'A',{'source_held':False})
            with self.assertRaises(ValueError):s.prepare('A','B',source_held=True)
            s.prepare('A','B')
            proof={k:True for k in ['boot','display','packages','account_hash','settings','userdata','foreground']}
            with self.assertRaises(ValueError):s.promote('B',cp,proof)
            self.assertEqual(s.state['owner'],'A')
    def test_stale_candidate_rejected(self):
        s=FakeStore()
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'disk';p.write_bytes(b'disk');cp=s.publish(p,'A',{'source_held':True})
            s.prepare('A','B',source_held=True);s.publish(p,'A',{})
            with self.assertRaises(m.Conflict):s.promote('B',cp,{k:True for k in ['boot','display','packages','account_hash','settings','userdata','foreground']})

if __name__=='__main__':unittest.main()
