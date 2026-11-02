import {chromium} from 'playwright';import fs from 'node:fs';import assert from 'node:assert/strict';
const base='https://android.aivideo.blitz.cloud',local=process.env.LOCAL_UI==='1',result={started_at:new Date().toISOString(),mode:local?'predeployment layout-only check':'deployed',tests:[]};
const save=()=>fs.writeFileSync('/home/user/floating_controls_test_results.json',JSON.stringify(result,null,2));
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 for(const mobile of [false,true]){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  if(local){const source=fs.readFileSync(new URL('../android-remote-gateway/src/phoneUi.ts',import.meta.url),'utf8');const html=source.slice(source.indexOf('`')+1,source.lastIndexOf('`'));await page.route(base+'/',r=>r.fulfill({contentType:'text/html',body:html}));}
  await page.goto(base,{waitUntil:'domcontentloaded'});if(local)await page.waitForFunction(()=>window.liveMetrics?.connections>0,null,{timeout:15000});else await page.waitForFunction(()=>window.liveMetrics?.decodedFrames>0,null,{timeout:60000});
  const geometry=await page.evaluate(()=>{const c=document.querySelector('canvas'),b=document.querySelector('#controls'),r=c.getBoundingClientRect(),q=b.getBoundingClientRect();return {canvas:{x:r.x,y:r.y,w:r.width,h:r.height},controls:{x:q.x,y:q.y,w:q.width,h:q.height},sourceRatio:c.width/c.height,viewport:{w:innerWidth,h:innerHeight},overlap:!(r.right<=q.left||r.left>=q.right||r.bottom<=q.top||r.top>=q.bottom)};});
  assert.ok(Math.abs(geometry.canvas.w/geometry.canvas.h-geometry.sourceRatio)<.001);assert.ok(!geometry.overlap,'Default controls overlap Android content');assert.ok(geometry.canvas.h>=geometry.viewport.h-65);
  const handle=await page.locator('#drag').boundingBox(),before=await page.locator('#controls').boundingBox();
  if(mobile){const cdp=await context.newCDPSession(page),x=handle.x+handle.width/2,y=handle.y+handle.height/2;await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});for(let i=1;i<=15;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+45*i/15,y:y-130*i/15}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  else{await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x-300,handle.y-200,{steps:20});await page.mouse.up();}
  const after=await page.locator('#controls').boundingBox();assert.ok(Math.hypot(before.x-after.x,before.y-after.y)>40);
  const full=page.locator('#fullscreenToggle');await full.click();await page.waitForFunction(()=>Boolean(document.fullscreenElement),null,{timeout:5000});assert.equal(await full.getAttribute('aria-pressed'),'true');await full.click();await page.waitForFunction(()=>!document.fullscreenElement);
  const afterButton=await page.locator('#controls').boundingBox();assert.ok(Math.abs(after.x-afterButton.x)<2&&Math.abs(after.y-afterButton.y)<2,'Button tap dragged controls');
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForTimeout(1500);const remembered=await page.locator('#controls').boundingBox();assert.ok(Math.abs(remembered.x-after.x)<2&&Math.abs(remembered.y-after.y)<2,'Session position not remembered');
  await page.setViewportSize(mobile?{width:844,height:390}:{width:600,height:600});await page.waitForTimeout(300);const clamped=await page.locator('#controls').boundingBox();const v=page.viewportSize();assert.ok(clamped.x>=0&&clamped.y>=0&&clamped.x+clamped.width<=v.width+1&&clamped.y+clamped.height<=v.height+1);
  assert.deepEqual(errors,[]);result.tests.push({device:mobile?'touch mobile':'mouse desktop',passed:true,geometry,drag:{before,after},native_fullscreen:true,position_remembered:true,clamped_after_resize:true});await page.screenshot({path:'/home/user/floating-phone-'+(mobile?'mobile':'desktop')+'.png'});save();await context.close();
 }
 result.passed=true;save();console.log('FLOATING_CONTROLS_LAYOUT_AND_NATIVE_FULLSCREEN_PASS');
}catch(e){result.passed=false;result.error=e.stack;save();throw e;}finally{await browser.close();}
