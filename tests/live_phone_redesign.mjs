import {chromium} from 'playwright';import fs from 'node:fs';
const base='https://android.aivideo.blitz.cloud';const result={started_at:new Date().toISOString(),tests:[],status:'waiting_for_live_h264'};const output='/home/user/android_redesign_live_results.json';const save=()=>fs.writeFileSync(output,JSON.stringify(result,null,2));save();
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(let i=0;i<120;i++){
  const r=await context.request.get(base).catch(()=>null);if(r?.ok()&&(await r.text()).includes('liveMetrics'))break;
  if(i===119)throw new Error('New phone UI not deployed in 20 minutes');await new Promise(r=>setTimeout(r,10000));
 }
 await page.goto(base,{waitUntil:'domcontentloaded',timeout:60000});
 await page.getByRole('button',{name:'Home',exact:true}).click();
 await page.waitForFunction(()=>window.liveMetrics?.frames>=1,{timeout:60000});
 for(let i=0;i<90;i++){
  const d=await context.request.get(base+'/api/status').then(r=>r.json());if(d.active_emulator?.device_info?.stream_transport==='scrcpy-h264'){result.session=d.active_emulator.session_id;break;}if(i===89)throw new Error('New Android H264 runner not active in 15 minutes');await new Promise(r=>setTimeout(r,10000));
 }
 const buttons=await page.locator('button:visible').evaluateAll(es=>es.map(e=>e.getAttribute('aria-label')));if(JSON.stringify([...buttons].sort())!==JSON.stringify(['Back','Full screen','Home'].sort()))throw new Error('Unwanted UI controls present: '+buttons.join(','));
 result.tests.push({name:'minimal_ui_desktop',passed:true,visible_buttons:buttons});
 await page.screenshot({path:'/home/user/android-redesign-desktop.png'});save();
 // Actual user input through Chromium pointer events -> viewer WebSocket -> Android control socket.
 await page.getByRole('button',{name:'Home',exact:true}).click();await page.waitForTimeout(1000);
 const box=await page.locator('canvas').boundingBox();const pt=(x,y)=>({x:box.x+box.width*x,y:box.y+box.height*y});
 async function swipe(x1,y1,x2,y2){const a=pt(x1,y1),b=pt(x2,y2);await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:18});await page.mouse.up();await page.waitForTimeout(600);}
 await swipe(.5,.88,.5,.25);await page.screenshot({path:'/home/user/android-redesign-app-drawer.png'});
 result.status='live_interaction_started';result.metrics=await page.evaluate(()=>window.liveMetrics);result.javascript_errors=errors;save();
 // Leave a reproducible artifact for inspection; the remaining assertions are added against actual app UI.
 await context.close();
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const mp=await mobile.newPage();await mp.goto(base,{waitUntil:'domcontentloaded',timeout:60000});await mp.waitForFunction(()=>window.liveMetrics?.frames>=2,{timeout:45000});await mp.screenshot({path:'/home/user/android-redesign-mobile.png'});result.tests.push({name:'minimal_ui_mobile',passed:await mp.locator('button:visible').count()===3});await mobile.close();save();console.log('LIVE_PHONE_UI_AND_POINTER_INITIAL_CHECKS',JSON.stringify(result.tests));
}catch(e){result.status='failed';result.error=e.stack;save();console.error('LIVE_PHONE_TEST_FAILED',e.message);process.exitCode=1;}finally{await browser.close();}
