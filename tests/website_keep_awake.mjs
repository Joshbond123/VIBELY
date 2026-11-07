import assert from 'node:assert/strict';
import {websiteHeartbeat} from '../dist/server/websiteKeepAwake.js';
const calls=[];
await websiteHeartbeat(async(url,options)=>{
 calls.push([url,options]);return new Response('<html>website</html>',{status:200});
});
assert.equal(calls.length,1);
assert.equal(calls[0][0],'https://aivideo.aivideo.prod.page/?website_keep_awake=1');
assert.ok(calls.every(([url])=>!url.includes('android')&&!url.includes('/gpu')&&!url.includes('/generate')&&!url.includes('/mcp')));
await assert.rejects(websiteHeartbeat(async()=>new Response('',{status:503})));
console.log('WEBSITE_ONLY_HEARTBEAT_UNIT_PASS — not a hosting uptime guarantee');
