import {chromium} from 'playwright';
import fs from 'node:fs';import assert from 'node:assert/strict';
const result={started_at:new Date().toISOString(),tests:[]};
const save=()=>fs.writeFileSync(process.env.RESULT_PATH||'/tmp/live_display_recovery_result.json',JSON.stringify(result,null,2));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('https://android.aivideo.blitz.cloud',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>window.liveMetrics?.frames>0,null,{timeout:90000});
 const session=(await context.request.get('https://android.aivideo.blitz.cloud/api/public/health').then(r=>r.json())).active_session_id;
 result.session=session;result.initial=await page.evaluate(()=>liveMetrics);result.tests.push({name:'real_H264_decoded',passed:true,decoded:result.initial.frames});save();
 const pixels=()=>page.evaluate(()=>{const c=document.createElement('canvas');c.width=20;c.height=40;const x=c.getContext('2d');x.drawImage(document.querySelector('canvas'),0,0,20,40);return [...x.getImageData(0,0,20,40).data]});
 await context.setOffline(true);await page.evaluate(()=>socket.close(4000,'Controlled loss test'));await page.waitForTimeout(1200);const before=await pixels();await page.waitForTimeout(1600);const after=await pixels();assert.deepEqual(after,before,'Last actual frame was cleared during outage');
 const state=await page.evaluate(()=>liveMetrics.connectionState);assert.equal(state,'temporarily_disconnected');result.tests.push({name:'offline_retains_actual_last_frame_and_reports_disconnection',passed:true});save();
 const frames=await page.evaluate(()=>liveMetrics.frames);await context.setOffline(false);
 await page.waitForFunction(n=>liveMetrics.frames>n,frames,{timeout:45000});
 const same=(await context.request.get('https://android.aivideo.blitz.cloud/api/public/health').then(r=>r.json())).active_session_id;assert.equal(same,session);result.tests.push({name:'network_recovery_resumes_decoding_without_OS_replacement',passed:true});
 result.final=await page.evaluate(()=>liveMetrics);result.javascript_errors=errors;assert.deepEqual(errors,[]);result.status='passed';save();console.log(JSON.stringify({status:result.status,session,tests:result.tests}));await context.close();
}catch(e){result.status='failed';result.error=e.message;save();console.error(e.message);process.exitCode=1;}finally{await browser.close();}
