// Local browser and fake wallet only; no live RPC or signing.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {chromium,expect} from '@playwright/test';
const payload=JSON.parse(await readFile('bnkr-deployment/payload.json','utf8'));
let server,browser,origin;
before(async()=>{
 const root=resolve('bnkr-deployment');
 server=createServer(async(req,res)=>{
  try{
   const pathname=new URL(req.url,'http://localhost').pathname;
   const path=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
   if(!path.startsWith(root+'/'))throw Error('outside root');
   res.setHeader('Content-Type',({'.mjs':'text/javascript','.html':'text/html','.css':'text/css','.json':'application/json'})[extname(path)]??'text/plain');
   res.end(await readFile(path));
  }catch{res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.STAKED_TEST_CHROME?{executablePath:process.env.STAKED_TEST_CHROME}:{}),args:['--no-sandbox']});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});
for(const width of [1280,390])test(`deployment page at ${width}px requires explicit connect and click`,async()=>{
 const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();
 const calls=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('fakeRpc',({method,params=[]})=>{
  calls.push(method);
  if(['eth_requestAccounts','eth_accounts'].includes(method))return[payload.plan.deployer];
  if(method==='eth_chainId')return'0x2105';
  if(method==='eth_getCode')return'0x';
  if(method==='eth_getTransactionCount')return'0x'+payload.plan.firstNonce.toString(16);
  if(method==='eth_getBlockByNumber')return{number:'0x319a000'};
  if(method==='eth_estimateGas')return'0xf4240';
  if(method==='eth_gasPrice')return'0x5b8d80';
  if(method==='eth_maxPriorityFeePerGas')return'0xf4240';
  if(method==='eth_getBalance')return'0xde0b6b3a7640000';
  if(method==='eth_call')return params[0].to?'0x174876e800':payload.verification[0].code;
  if(method==='eth_sendTransaction')return'FAKE_REJECTION';
  throw Error('Unexpected '+method);
 });
 await page.addInitScript(()=>{window.ethereum={isRabby:true,on(){},async request(r){const v=await window.fakeRpc(r);if(v==='FAKE_REJECTION')throw Object.assign(Error('Rejected in local test'),{code:4001});return v;}};});
 try{
  await page.goto(origin);await expect(page.locator('#connect')).toBeEnabled();assert.equal(calls.length,0);
  await expect(page.locator('#deploy-0')).toBeDisabled();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#connect').click();await expect(page.locator('#deploy-0')).toBeEnabled();
  assert(!calls.includes('eth_sendTransaction'));
  await page.locator('#deploy-0').click();await expect(page.locator('#status')).toContainText('Rejected in local test');
  assert.equal(calls.filter(m=>m==='eth_sendTransaction').length,1);assert.deepEqual(errors,[]);
 }finally{await context.close();}
});
