import assert from 'node:assert/strict';
import {websiteHeartbeat} from '../dist/server/websiteKeepAwake.js';
const calls=[];
await websiteHeartbeat('unit-test-only',async(url,options)=>{
 calls.push([url,options]);
 return new Response(url.includes('/mcp')?JSON.stringify({jsonrpc:'2.0',result:{}}):'<html>website</html>',{status:200});
});
assert.equal(calls.length,3);
const action=JSON.parse(calls[1][1].body);
assert.equal(action.params.name,'apps_resume');
assert.equal(action.params.arguments.app,'66184937-3da8-4df4-88af-eb475f889a43');
assert.equal(calls[2][0],'https://aivideo.aivideo.prod.page/?website_keep_awake=1');
assert.ok(calls.every(([url])=>!url.includes('android')&&!url.includes('/gpu')&&!url.includes('/generate')));
await assert.rejects(websiteHeartbeat('unit-test-only',async()=>new Response('',{status:401})));
console.log('WEBSITE_ONLY_HEARTBEAT_UNIT_PASS — not a hosting uptime guarantee');
