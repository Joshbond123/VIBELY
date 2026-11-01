import {chromium} from 'playwright';import fs from 'node:fs';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const results=[];
for(const width of [1440,390]){
 const context=await browser.newContext({viewport:{width,height:1000},permissions:['clipboard-read','clipboard-write']});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('https://aivideo.aivideo.blitz.cloud/',{waitUntil:'domcontentloaded',timeout:60000});const panel=page.getByTestId('gpu-monitor');await panel.waitFor({timeout:45000});await panel.locator('article').first().waitFor({timeout:30000});
 const cards=await panel.locator('article').count();if(cards!==2)throw new Error('Expected real video/music GPU cards');await panel.screenshot({path:`/home/user/gpu-dashboard-${width}.png`});
 results.push({width,cards,javascript_errors:errors,text:await panel.innerText()});await context.close();
}
await browser.close();fs.writeFileSync('/home/user/gpu_dashboard_browser_results.json',JSON.stringify(results,null,2));console.log('REAL_GPU_DASHBOARD_BROWSER_PASS',results.map(x=>({width:x.width,cards:x.cards,javascript_errors:x.javascript_errors})));
