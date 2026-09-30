import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {fixture,plan} from './v3-page-fixture.mjs';
let server,browser,origin;
before(async()=>{
 const root=resolve('.');server=createServer(async(req,res)=>{try{let path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!path.startsWith(root+'/'))throw Error();if((await stat(path)).isDirectory())path+='/index.html';res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'})[extname(path)]??'application/octet-stream');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.STAKED_TEST_CHROME?{executablePath:process.env.STAKED_TEST_CHROME}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
test('browser loads under CSP and completes exactly five mocked wallet approvals',async()=>{
 const f=fixture(),context=await browser.newContext(),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));await page.exposeFunction('testRpc',request=>f.provider.request(request));
 await page.addInitScript(()=>{window.ethereum={isRabby:true,request:r=>window.testRpc(r),on:()=>{}};});
 await page.goto(origin+'/v3-deployment/');await page.locator('#file').setInputFiles({name:'deployment-plan.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(plan))});
 await expect(page.locator('#status')).toContainText('Plan matches');await page.locator('#connect').click();
 for(let i=0;i<5;i++){await expect(page.locator('#deploy')).toBeEnabled();await expect(page.locator('#deploy')).toContainText(`${i+1} of 5`);await page.locator('#deploy').click();}
 await expect(page.locator('#status')).toContainText('All five deployments verified');assert.equal(f.state.calls.filter(c=>c.method==='eth_sendTransaction').length,5);assert.deepEqual(errors,[]);
 await page.screenshot({path:'/tmp/staked-v3-signing-page.png',fullPage:true});await context.close();
});
test('browser rejects an altered creation without requesting the wallet',async()=>{
 const context=await browser.newContext(),page=await context.newPage();await page.goto(origin+'/v3-deployment/');const p=structuredClone(plan);p.deployments[2].data+='00';
 await page.locator('#file').setInputFiles({name:'deployment-plan.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(p))});await expect(page.locator('#status')).toContainText('Creation transactions differ');await expect(page.locator('#connect')).toBeDisabled();await context.close();
});
