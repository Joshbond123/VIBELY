import assert from 'node:assert/strict';
import {planVideoFrames,assertActualVideoDuration} from '../src/server/videoDuration.ts';
for(let t=15;t<=50;t+=.013){
 const f=planVideoFrames(t);assert.equal(f.length,3);assert.ok(f.every(Number.isInteger));
 const sec=f.reduce((a,b)=>a+b,0)/24;assert.ok(sec>=25 && sec<40);assertActualVideoDuration(sec);
}
assert.equal(planVideoFrames().reduce((a,b)=>a+b,0),624);
for(const t of [0,24.999,40.00001,NaN,Infinity,-Infinity])assert.throws(()=>assertActualVideoDuration(t));
for(const t of [25,26,39.999,40])assert.equal(assertActualVideoDuration(t),t);
assert.throws(()=>planVideoFrames(NaN));
assert.equal(assertActualVideoDuration(22,20),22); // Preserve pre-policy in-flight legacy jobs only.
console.log('PASS: frame-aligned plans, strict actual metadata limits, and legacy policy isolation');
