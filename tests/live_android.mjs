import { chromium } from 'playwright';
import fs from 'node:fs';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const results=[];
for(const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
 const context=await browser.newContext({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500});
 const page=await context.newPage();let frameCount=0;const errors=[];
 let gotFrames;const streamReady=new Promise(resolve=>{gotFrames=resolve;});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('websocket',socket=>socket.on('framereceived',event=>{if(typeof event.payload!=='string') {frameCount++;if(frameCount>=4)gotFrames();}}));
 await page.goto('https://android.aivideo.blitz.cloud/',{waitUntil:'domcontentloaded',timeout:45000});
 await page.waitForSelector('#fullscreenToggle',{timeout:20000});
 await page.waitForFunction(()=>document.querySelector('#fpsBadge').textContent!=='0 FPS',{timeout:30000});
 await Promise.race([streamReady,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Live frame timeout')),20000))]);
 const surface=await page.locator('#screen').boundingBox();
 const iframes=await page.locator('iframe:visible').count();
 const hiddenSecurityFrames=await page.locator('iframe').count()-iframes;
 const state=await page.evaluate(async()=>await (await fetch('/api/status')).json());
 const file='/home/user/android-fullscreen-'+viewport.width+'.png';
 await page.screenshot({path:file,fullPage:false});
 await page.locator('#toolsToggle').click();
 const toolsOpened=await page.evaluate(()=>document.body.classList.contains('tools-open'));
 await page.locator('#toolsToggle').click();
 const home=await page.evaluate(async()=>{const r=await fetch('/api/input',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'keyevent',keycode:3})});return {status:r.status,body:await r.json()};});
 const activity=await page.evaluate(async()=>await (await fetch('/api/adb/shell',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:'dumpsys activity activities | grep ResumedActivity'})})).json());
 // Test real pointer input, not just a fetch: tap central launcher region.
 await page.locator('#screen').tap({position:{x:surface.width/2,y:surface.height*.7}}).catch(async()=>page.mouse.click(surface.x+surface.width/2,surface.y+surface.height*.7));
 results.push({viewport,surface,iframes,hiddenSecurityFrames,frameCount,toolsOpened,home,activity:activity.stdout,active:state.active_emulator?.session_id,errors,screenshot:file});
 await context.close();
}
fs.writeFileSync('/home/user/android_fullscreen_test_results.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));await browser.close();
if(results.some(x=>x.iframes!==0 || x.frameCount<3 || !x.active || x.errors.length || x.home.status!==200 || x.surface.height<x.viewport.height*.85))process.exit(1);
