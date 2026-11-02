"""Pinned content verification, without importing CUDA or treating file size as quality."""
from dataclasses import dataclass
import hashlib
from pathlib import Path
import re

@dataclass(frozen=True)
class ModelArtifact:
 repo: str
 revision: str
 filename: str
 bytes: int
 sha256: str
 def validate(self):
  if not re.fullmatch(r'[0-9a-f]{40}',self.revision):raise ValueError('Pin an immutable repository revision')
  if not re.fullmatch(r'[0-9a-f]{64}',self.sha256):raise ValueError('Expected SHA256 required')
  if self.bytes<1 or Path(self.filename).is_absolute() or '..' in Path(self.filename).parts:raise ValueError('Invalid artifact path or size')

def verify_artifact(path,artifact):
 artifact.validate();p=Path(path);stat=p.stat()
 if stat.st_size!=artifact.bytes:raise ValueError('Exact model size mismatch; 97 percent is not a valid checkpoint')
 h=hashlib.sha256()
 with p.open('rb') as f:
  for block in iter(lambda:f.read(16*1024*1024),b''):h.update(block)
 if h.hexdigest()!=artifact.sha256:raise ValueError('Model SHA256 mismatch; refuse loading')
 return {'path':str(p),'sha256':h.hexdigest(),'bytes':stat.st_size,'revision':artifact.revision}
