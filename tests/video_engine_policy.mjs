import assert from 'node:assert/strict';
import {NVIDIA_VIDEO_MODEL,NVIDIA_VIDEO_SPEC,validateRequestedVideoEngine,redactStartupError} from '../dist/server/videoEnginePolicy.js';
import {retryAfterMs,providerFrameCount,decodeProviderVideo} from '../dist/server/nvidiaVideoProvider.js';
import {GPU_PROFILES} from '../dist/server/gpuFleetPolicy.js';
assert.equal(validateRequestedVideoEngine(undefined),null);
assert.equal(validateRequestedVideoEngine(NVIDIA_VIDEO_MODEL),null);
for(const old of ['minimax_h3_ref2va','wan_animate_2_distilled_14b','arbitrary-model'])assert.match(validateRequestedVideoEngine(old),/no GPU fallback/i);
assert.equal(NVIDIA_VIDEO_SPEC.visual_acceptance,'not_verified');
assert.equal(GPU_PROFILES.length,2);assert.ok(GPU_PROFILES.every(p=>p.role==='music'));
assert.equal(retryAfterMs('90'),90000);assert.equal(retryAfterMs(null),60000);
assert.equal(retryAfterMs(new Date(200000).toUTCString(),100000),100000);
for(let i=1;i<=196;i++){const frames=providerFrameCount(i);assert.ok(frames>=25&&frames<=197&&frames>=i);assert.equal((frames-1)%4,0);}
assert.throws(()=>providerFrameCount(197));assert.throws(()=>decodeProviderVideo({video_url:'sample.mp4'}));assert.throws(()=>decodeProviderVideo({b64_video:'not-mp4'}));
assert.equal(redactStartupError('Bearer private-value hf_fakecredential'),'Bearer [REDACTED] [REDACTED]');
assert.ok(!redactStartupError('Function not found for account "private-account-id"').includes('private-account-id'));
console.log('NVIDIA_POLICY_UNIT_PASS — not live generation or provider-rate-limit acceptance');
