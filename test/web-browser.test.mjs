// Real browser, local page, fake EIP-1193 wallet and RPC. Never uses a live key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { ethers } from 'ethers';
import { CONFIG } from '../web/src/config.js';

let server, browser, origin;
const account='0x1111111111111111111111111111111111111111';
const now=Math.floor(Date.now()/1000);
const abi=new ethers.utils.Interface([
 'function balanceOf(address) view returns(uint256)', 'function totalSupply() view returns(uint256)',
 'function allowance(address,address) view returns(uint256)', 'function lockEnd(address) view returns(uint256)',
 'function earned(address,address) view returns(uint256)', 'function rewardRatePerSecond(address) view returns(uint256)',
 'function previewWithdraw(address,uint256) view returns(uint256,uint256,uint256,uint256)',
 'function buybackReserve() view returns(uint256)',
 'function idlePrincipal() view returns(uint256)', 'function paused() view returns(bool)', 'function staking() view returns(address)', 'function safe() view returns(address)', 'function stakeOf(address) view returns(uint256)',
 'function approve(address,uint256) returns(bool)', 'function stake(uint256)', 'function withdraw(uint256)',
 'function earlyWithdraw(uint256)', 'function getReward()',
]);
const units=ethers.utils.parseEther;
const hash='0x'+'ab'.repeat(32);
const block={hash,parentHash:hash,number:'0x3190000',timestamp:ethers.utils.hexValue(now),nonce:'0x0000000000000000',difficulty:'0x0',gasLimit:'0x1c9c380',gasUsed:'0x0',miner:account,extraData:'0x',transactions:[],baseFeePerGas:'0x1'};
before(async()=>{
 const root=resolve('.');
 server=createServer(async(req,res)=>{
  try {
   let path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);
   if(!path.startsWith(root+'/') && path!==root) throw new Error('outside root');
   if((await stat(path)).isDirectory()) path+='/index.html';
   const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'}[extname(path)]||'application/octet-stream';
   res.writeHead(200,{'Content-Type':type});res.end(await readFile(path));
  } catch {res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.STAKED_TEST_CHROME?{executablePath:process.env.STAKED_TEST_CHROME}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
});
after(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));});

async function fixture(options={}) {
 const state={chain:'0x2105',account,allowance:'0',sent:[],calls:[],previewFail:false,...options};
 const context=await browser.newContext({viewport:options.viewport || {width:1280,height:900}});
 const page=await context.newPage();
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 async function rpc({method,params=[]}, wallet=false) {
  if(method==='eth_call' && ((wallet && state.walletReadFail) || (!wallet && state.publicReadFail))) throw {code:-32000,message:'simulated read endpoint failure'};
  state.calls.push(method);
  if(method==='eth_chainId')return state.chain;
  if(['eth_accounts','eth_requestAccounts'].includes(method))return [state.account];
  if(method==='net_version')return '8453';
  if(method==='eth_blockNumber')return block.number;
  if(method==='eth_getBlockByNumber')return block;
  if(method==='eth_getLogs')return [];
  if(method==='eth_getCode')return '0x6000';
  if(method==='eth_getBalance')return units('10').toHexString();
  if(method==='eth_getTransactionCount')return '0x0';
  if(method==='eth_gasPrice')return '0x3b9aca00';
  if(method==='eth_estimateGas')return '0x186a0';
  if(method==='eth_sendTransaction') {state.sent.push(params[0]);throw {code:state.uncertain ? -32000 : 4001,message:state.uncertain ? 'connection lost after send' : 'user rejected fake test request'};}
  if(method==='eth_call') {
   const tx=params[0];const p=abi.parseTransaction({data:tx.data});
   let values;
   if (state.bnkrReadFail && ['idlePrincipal','paused','stakeOf'].includes(p.name)) throw {code:-32000,message:'staking reads unavailable'};
   if(p.name==='idlePrincipal')values=[units('12.5')];
   else if(p.name==='paused')values=[true];
   else if(p.name==='staking')values=['0x88470240ff0663faefa68b1d7621b472ddd9584a'];
   else if(p.name==='safe')values=['0xb9066550918fa778a4039120eac878230cf8f6FC'];
   else if(p.name==='stakeOf')values=[units('456.75')];
   else if(p.name==='approve')values=[true];
   else if(p.name==='buybackReserve')values=[state.usdcReserve ?? '25000000'];
   else if(p.name==='balanceOf' && tx.to.toLowerCase()===CONFIG.USDC_TOKEN.toLowerCase())values=[state.usdcPoolBalance ?? '125000000'];
   else if(p.name==='balanceOf'||p.name==='totalSupply')values=[units('1000')];
   else if(p.name==='allowance')values=[state.allowance];
   else if(p.name==='lockEnd')values=[state.expiry ?? (state.mature ? now-60 : now+86400)];
   else if(p.name==='earned'||p.name==='rewardRatePerSecond')values=[state.rewards && p.name==='earned' ? 1000000 : 0];
   else if(p.name==='previewWithdraw') {
    if(state.previewFail)throw {code:-32000,message:'execution reverted'};
    values=[p.args[1].mul(80).div(100),p.args[1].mul(20).div(100),1000000,units('2')];
   } else values=[];
   return abi.encodeFunctionResult(p.name,values);
  }
  throw {code:-32601,message:'unhandled test RPC '+method};
 }
 await page.exposeFunction('__testRpc',async payload=>{try{return {result:await rpc(payload,true)}}catch(e){return {error:{code:e.code??-32000,message:e.message}}}});
 await page.addInitScript(()=>{
  window.cspViolations=[];
  document.addEventListener('securitypolicyviolation',e=>window.cspViolations.push({directive:e.violatedDirective,blocked:e.blockedURI}));
  window.ethereum={on(){},request:async payload=>{const r=await window.__testRpc(payload);if(r.error)throw r.error;return r.result;}};
 });
 await page.route('**/*',async route=>{
  const req=route.request();
  if(options.mockWc && req.url().startsWith(origin)) {
   const meta=JSON.parse(await readFile('build/web-metafile.json','utf8'));
   const chunk=Object.entries(meta.outputs).find(([,v])=>v.entryPoint==='web/src/wallet-connect.js')[0];
   if(new URL(req.url()).pathname==='/'+chunk) return route.fulfill({contentType:'text/javascript',body:await readFile('test/fixtures/wc-provider.js','utf8')});
  }
  if(req.url().startsWith(origin))return route.continue();
  if(req.method()==='POST' && /base\.org|publicnode\.com/.test(req.url())) {
   const data=req.postDataJSON();
   const one=async p=>{try{return {jsonrpc:'2.0',id:p.id,result:await rpc(p)}}catch(e){return {jsonrpc:'2.0',id:p.id,error:e}}};
   return route.fulfill({json:Array.isArray(data)?await Promise.all(data.map(one)):await one(data),headers:{'access-control-allow-origin':'*'}});
  }
  if(req.url().includes('/v3/wallets'))return route.fulfill({json:{listings:{}}});
  return route.fulfill({status:200,body:'',contentType:req.resourceType()==='stylesheet'?'text/css':'text/plain'});
 });
 await page.goto(origin+(options.path||'/'),{waitUntil:'load'});
 await expect(page.locator('#totalStakedDisplay')).toHaveText('1,000');
 const connect=async()=>{await page.click('#connectBtn');await page.click('[data-action="ui-14"]');await page.locator('#injectedList button').first().click();await expect(page.locator('#walletTokenBalance')).toHaveText('1,000');};
 return {page,state,errors,connect,close:()=>context.close()};
}

test('built page renders, preserves live addresses and loads only local executable code',async()=>{
 const f=await fixture();try {
  assert.equal(f.state.sent.length,0);
  assert.equal(await f.page.locator('#vaultScanLink').getAttribute('href'),'https://basescan.org/address/'+CONFIG.VAULT_ADDRESS);
  assert.deepEqual(f.errors,[]);
  assert.deepEqual(await f.page.evaluate(()=>window.cspViolations),[]);
  const sources=await f.page.locator('script[src]').evaluateAll(es=>es.map(e=>e.src));
  assert.ok(sources.every(src=>src.startsWith(origin+'/assets/vault/')));
  const meta=JSON.parse(await readFile('build/web-metafile.json','utf8'));
  const [wc]=Object.entries(meta.outputs).find(([,v])=>v.entryPoint==='web/src/wallet-connect.js');
  assert.equal(await f.page.evaluate(async src=>typeof (await import(src)).EthereumProvider.init,origin+'/'+wc),'function');
  assert.deepEqual(f.errors,[]);
  assert.deepEqual(await f.page.evaluate(()=>window.cspViolations),[]);
 }finally{await f.close();}
});
test('exact approval requests the current amount once, and cancellation shows a friendly error',async()=>{
 const f=await fixture();try {
  await f.connect();await f.page.fill('#stakeInput','12.000000000000000001');
  await expect(f.page.locator('#stakeActionBtn')).toHaveText('Approve $STAKED');
  await f.page.evaluate(()=>{const b=document.getElementById('stakeActionBtn');b.click();b.click();});
  await expect.poll(()=>f.state.sent.length).toBe(1);
  const tx=f.state.sent[0],decoded=abi.parseTransaction({data:tx.data});
  assert.equal(tx.to.toLowerCase(),CONFIG.STAKED_TOKEN.toLowerCase());
  assert.equal(decoded.name,'approve');assert.equal(decoded.args[0].toLowerCase(),CONFIG.VAULT_ADDRESS.toLowerCase());
  assert.equal(decoded.args[1].toString(),'12000000000000000001');
  await expect(f.page.locator('#toastMsg')).toContainText('cancelled');
  assert.equal(f.state.sent.length,1);
 }finally{await f.close();}
});
test('wrong network or changed account blocks transaction requests',async()=>{
 for(const kind of ['chain','account']) {
  const f=await fixture();try {
   await f.connect();await f.page.fill('#stakeInput','1');
   f.state[kind]=kind==='chain'?'0x1':'0x2222222222222222222222222222222222222222';
   await f.page.click('#stakeActionBtn');
   await expect(f.page.locator('#toastMsg')).toContainText(kind==='chain'?'Switch your wallet to Base':'account changed');
   assert.equal(f.state.sent.length,0);
  }finally{await f.close();}
 }
});
test('existing excessive approval can be reduced to the entered amount',async()=>{
 const f=await fixture({allowance:ethers.constants.MaxUint256.toString()});try {
  await f.connect();await f.page.fill('#stakeInput','2');
  await expect(f.page.locator('#approvalNotice')).toBeVisible();await f.page.click('#reduceApprovalBtn');
  await expect.poll(()=>f.state.sent.length).toBe(1);
  assert.equal(abi.parseTransaction({data:f.state.sent[0].data}).args[1].toString(),units('2').toString());
 }finally{await f.close();}
});
test('partial early withdrawal names the complete reward forfeiture and cancellation sends nothing',async()=>{
 const f=await fixture();try {
  await f.connect();await f.page.click('#tabUnstake');await f.page.fill('#unstakeInput','100');
  let warning='';f.page.once('dialog',async dialog=>{warning=dialog.message();await dialog.dismiss();});
  await f.page.click('#unstakeActionBtn');
  await expect.poll(()=>warning).toContain('ALL accrued rewards for your entire stake');
  assert.match(warning,/20\.0 STAKED will be burned/);assert.match(warning,/tokens you leave staked/);
  await expect(f.page.locator('#unstakeActionBtn')).toBeEnabled();assert.equal(f.state.sent.length,0);
 }finally{await f.close();}
});
test('failed withdrawal preview stops before confirmation or a transaction request',async()=>{
 const f=await fixture({previewFail:true});try {
  await f.connect();await f.page.click('#tabUnstake');await f.page.fill('#unstakeInput','100');
  let dialogs=0;f.page.on('dialog',async d=>{dialogs++;await d.dismiss();});await f.page.click('#unstakeActionBtn');
  await expect(f.page.locator('#toastMsg')).toContainText('contract could not complete');
  assert.equal(dialogs,0);assert.equal(f.state.sent.length,0);
 }finally{await f.close();}
});
test('invalid decimal inputs disable actions and the nested web entry loads correctly',async()=>{
 const f=await fixture({path:'/web/'});try {
  await f.connect();for(const value of ['1e2','-1','0.0000000000000000001']) {
   await f.page.fill('#stakeInput',value);await expect(f.page.locator('#stakeActionBtn')).toBeDisabled();
  }
  assert.equal(f.state.sent.length,0);assert.deepEqual(f.errors,[]);
 }finally{await f.close();}
});

 test('legacy page blocks deposits and directs withdrawals to the original vault',async()=>{
 const f=await fixture({path:'/legacy/',mature:true});try{await f.connect();
 await expect(f.page.locator('#vaultLabel')).toHaveText('Existing V2 stakes');
 await expect(f.page.locator('#stakeActionBtn')).toBeDisabled();
 await f.page.fill('#unstakeInput','10');await f.page.click('#unstakeActionBtn');
 await expect.poll(()=>f.state.sent.length).toBe(1);
 assert.equal(f.state.sent[0].to.toLowerCase(),'0x01b568ebcfb8c6db2cf1c5f70c9b105f4187d92f');
 assert.equal(abi.parseTransaction({data:f.state.sent[0].data}).name,'withdraw');
 }finally{await f.close();}});
 test('V3 locked withdrawals use earlyWithdraw, mature withdrawals use withdraw',async()=>{
 for(const mature of [false,true]){const f=await fixture({mature});try{await f.connect();await f.page.click('#tabUnstake');await f.page.fill('#unstakeInput','10');
 f.page.on('dialog',d=>d.accept());await f.page.click('#unstakeActionBtn');await expect.poll(()=>f.state.sent.length).toBe(1);
 assert.equal(abi.parseTransaction({data:f.state.sent[0].data}).name,mature?'withdraw':'earlyWithdraw');assert.equal(f.state.sent[0].to.toLowerCase(),CONFIG.VAULT_ADDRESS.toLowerCase());
 }finally{await f.close();}}});
 test('uncertain submission survives reload and blocks a duplicate request',async()=>{
 const f=await fixture({uncertain:true});try{await f.connect();await f.page.fill('#stakeInput','5');await f.page.click('#stakeActionBtn');
 await expect.poll(()=>f.state.sent.length).toBe(1);await expect(f.page.locator('#pendingNotice')).toBeVisible();
 await f.page.reload();await f.connect();await expect(f.page.locator('#pendingNotice')).toBeVisible();await f.page.fill('#stakeInput','5');await f.page.click('#stakeActionBtn');
 await expect(f.page.locator('#toastMsg')).toContainText('unresolved');assert.equal(f.state.sent.length,1);
 }finally{await f.close();}});
 test('mobile and desktop viewports fit without horizontal scrolling',async()=>{
 for(const width of [320,375,390,768,1440]){const f=await fixture({viewport:{width,height:900}});try{
 assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),JSON.stringify(await f.page.evaluate(()=>[...document.querySelectorAll("body *")].filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,id:e.id,cl:e.className,w:e.getBoundingClientRect().width})).slice(0,15))));
 if(width===390||width===1440)await f.page.screenshot({path:`/tmp/staked-page-${width}.png`,fullPage:true});
 await f.page.click('#connectBtn');await expect(f.page.locator('#walletModal')).toBeVisible();
 assert.ok(await f.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`modal overflow at ${width}px`);
 if(width===390||width===1440)await f.page.screenshot({path:`/tmp/staked-public-${width}.png`,fullPage:true});
 }finally{await f.close();}}});

test('V3 stake targets the new vault and confirms an existing position lock reset',async()=>{
 const f=await fixture({allowance:units('20').toString()});try{await f.connect();await f.page.fill('#stakeInput','10');
 let warning='';f.page.once('dialog',async d=>{warning=d.message();await d.accept();});await f.page.click('#stakeActionBtn');
 await expect.poll(()=>f.state.sent.length).toBe(1);assert.match(warning,/ENTIRE position/);
 const tx=f.state.sent[0];assert.equal(tx.to.toLowerCase(),CONFIG.VAULT_ADDRESS.toLowerCase());const parsed=abi.parseTransaction({data:tx.data});assert.equal(parsed.name,'stake');assert.equal(parsed.args[0].toString(),units('10').toString());
 }finally{await f.close();}});
test('mature reward claim targets the selected vault without approving tokens',async()=>{
 for(const path of ['/','/legacy/']){const f=await fixture({path,mature:true,rewards:true});try{await f.connect();await f.page.click('#claimRewardsBtn');await expect.poll(()=>f.state.sent.length).toBe(1);const tx=f.state.sent[0];assert.equal(abi.parseTransaction({data:tx.data}).name,'getReward');assert.equal(tx.to.toLowerCase(),path==='/'?CONFIG.VAULT_ADDRESS.toLowerCase():'0x01b568ebcfb8c6db2cf1c5f70c9b105f4187d92f');}finally{await f.close();}}
});

test('connected wallet may reject eth_call while independent Base reads show the stake',async()=>{
 const f=await fixture({walletReadFail:true});try{await f.connect();await expect(f.page.locator('#userStakedDisplay')).toHaveText('1,000');await expect(f.page.locator('#accountReadStatus')).toContainText('updated');assert.equal(f.state.sent.length,0);}finally{await f.close();}
});
test('failed public balance reads show unavailable, disable actions, and recover on refresh',async()=>{
 const f=await fixture();try{await f.connect();f.state.publicReadFail=true;await f.page.click('#refreshBalances');await expect(f.page.locator('#userStakedDisplay')).toHaveText('Unavailable',{timeout:20000});await expect(f.page.locator('#stakeActionBtn')).toBeDisabled();await expect(f.page.locator('#claimRewardsBtn')).toBeDisabled();f.state.publicReadFail=false;await f.page.click('#refreshBalances');await expect(f.page.locator('#userStakedDisplay')).toHaveText('1,000',{timeout:20000});assert.equal(f.state.sent.length,0);}finally{await f.close();}
});

test('only header connects while disconnected; extension choice uses selected provider',async()=>{
 const f=await fixture();try {
  await expect(f.page.locator('#stakeActionBtn')).toBeHidden();
  await f.page.evaluate(()=>{
   window.selected=[];
   for(const name of ['Rabby','MetaMask']) {
    const provider={on(){},request:async p=>{if(p.method==='eth_requestAccounts')window.selected.push(name);return window.ethereum.request(p);}};
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{name,uuid:name},provider}}));
   }
  });
  await f.page.click('#connectBtn');await f.page.click('[data-action="ui-14"]');
  await expect(f.page.locator('#injectedList button')).toHaveCount(2);
  await f.page.getByRole('button',{name:'Rabby',exact:true}).click();
  await expect(f.page.locator('#userStakedDisplay')).toHaveText('1,000');
  assert.deepEqual(await f.page.evaluate(()=>window.selected),['Rabby']);
  await expect(f.page.locator('#stakeActionBtn')).toBeVisible();
 }finally{await f.close();}
});
test('lock expiry updates claim eligibility and removes penalty without refresh',async()=>{
 const f=await fixture({expiry:now+60,rewards:true});try {
  await f.page.clock.install({time:new Date(now*1000)});await f.connect();
  await f.page.click('#tabUnstake');await f.page.fill('#unstakeInput','10');
  await expect(f.page.locator('#penaltyWarningBox')).toBeVisible();await expect(f.page.locator('#claimRewardsBtn')).toBeDisabled();
  await f.page.clock.fastForward(61000);
  await expect(f.page.locator('#penaltyWarningBox')).toBeHidden();await expect(f.page.locator('#claimRewardsBtn')).toBeEnabled();
  await expect(f.page.locator('#unstakeActionBtn')).toHaveText('Unstake $STAKED');assert.equal(f.state.sent.length,0);
 }finally{await f.close();}
});
test('invalid saved request does not block reads and cannot be cleared by an unrelated hash',async()=>{
 const f=await fixture();try {
  await f.page.evaluate(a=>localStorage.setItem('staked:base:pending:'+a,'{broken'),account);
  await f.connect();await expect(f.page.locator('#userStakedDisplay')).toHaveText('1,000');
  await expect(f.page.locator('#pendingText')).toContainText('unreadable');await expect(f.page.locator('#checkPending')).toBeDisabled();
  await f.page.fill('#stakeInput','10');await f.page.click('#stakeActionBtn');
  await expect(f.page.locator('#toastMsg')).toContainText('unresolved');assert.equal(f.state.sent.length,0);
  assert.equal(await f.page.evaluate(a=>localStorage.getItem('staked:base:pending:'+a),account),'{broken');
 }finally{await f.close();}
});

async function startMobile(page) {
 await page.click('#connectBtn');await page.click('[data-action="ui-13"]');
 await page.getByRole('button',{name:/Show QR code/}).click();
}
test('closing WalletConnect clears its pairing; repeated clicks create only one attempt',async()=>{
 const f=await fixture({mockWc:true});try {
  await startMobile(f.page);await expect.poll(()=>f.page.evaluate(()=>window.wcTest?.enables)).toBe(1);
  await f.page.locator('#wcList button').first().evaluate(b=>{b.click();b.click();});
  assert.equal(await f.page.evaluate(()=>window.wcTest.inits),1);
  await f.page.click('[data-action="ui-12"]');
  await expect.poll(()=>f.page.evaluate(()=>window.wcTest.removed)).toBe(1);
  await expect(f.page.locator('#connectBtn')).toHaveText('Connect Wallet');
  await startMobile(f.page);await expect.poll(()=>f.page.evaluate(()=>window.wcTest.enables)).toBe(2);
  assert.equal(await f.page.evaluate(()=>window.wcTest.maxActive),1);
  await f.page.click('[data-action="ui-17"]');
  await expect.poll(()=>f.page.evaluate(()=>window.wcTest.removed)).toBe(2);
  assert.equal(f.state.sent.length,0);
 }finally{await f.close();}
});
test('closing during WalletConnect startup prevents enable and ignores late initialization',async()=>{
 const f=await fixture({mockWc:true});try {
  await f.page.evaluate(()=>{window.wcTest={inits:0,enables:0,active:0,maxActive:0,removed:0,delayInit:true};});
  await startMobile(f.page);await expect.poll(()=>f.page.evaluate(()=>!!window.wcTest.releaseInit)).toBe(true);
  await f.page.click('[data-action="ui-12"]');await f.page.evaluate(()=>window.wcTest.releaseInit());
  await f.page.evaluate(()=>{window.wcTest.delayInit=false});
  await startMobile(f.page);await expect.poll(()=>f.page.evaluate(()=>window.wcTest.enables)).toBe(1);
  assert.equal(await f.page.evaluate(()=>window.wcTest.inits),2);
  await f.page.click('[data-action="ui-12"]');assert.equal(f.state.sent.length,0);
 }finally{await f.close();}
});
test('late WalletConnect approval after closing is disconnected without adopting account',async()=>{
 const f=await fixture({mockWc:true});try {
  await startMobile(f.page);await expect.poll(()=>f.page.evaluate(()=>window.wcTest?.enables)).toBe(1);
  await f.page.evaluate(()=>{document.querySelector('[data-action="ui-12"]').click();window.wcTest.approve();});
  await expect.poll(()=>f.page.evaluate(()=>window.wcTest.disconnected)).toBe(1);
  await expect(f.page.locator('#connectBtn')).toHaveText('Connect Wallet');assert.equal(f.state.sent.length,0);
 }finally{await f.close();}
});

for (const viewport of [{width:1280,height:900},{width:390,height:844}]) {
 test(`BNKR protocol balances separate principal, Safe funds and wallet rewards at ${viewport.width}px`, async()=>{
  const f=await fixture({viewport});try {
   await expect(f.page.locator('#usdcPool')).toHaveText('100.00');
   await expect(f.page.locator('#bnkrAwaiting')).toHaveText('12.5');
   await expect(f.page.locator('#bnkrActive')).toHaveText('456.75');
   await expect(f.page.locator('#bnkrSafe')).toHaveText('1,000');
   await expect(f.page.locator('#bnkrStakingStatus')).toHaveText('Staking deposits paused');
   await expect(f.page.locator('#earnedBNKRDisplay')).toHaveText('—');
   assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await f.page.locator('#bnkrProtocolStats').screenshot({path:`/tmp/bnkr-panel-${viewport.width}.png`});
   f.state.bnkrReadFail=true;
   await f.page.click('#refreshBnkrStats');
   await expect(f.page.locator('#bnkrActive')).toHaveText('Unavailable',{timeout:20000});
   await expect(f.page.locator('#usdcPool')).toHaveText('Unavailable');
   assert.equal(f.state.sent.length,0);
  }finally{await f.close();}
 });
}

test('USDC pool never shows buyback funds or hides positive sub-cent balances',async()=>{
 const f=await fixture({usdcPoolBalance:'25000001',usdcReserve:'25000000'});try {
  await expect(f.page.locator('#usdcPool')).toHaveText('<0.01');
  f.state.usdcPoolBalance='24999999';
  await f.page.click('#refreshBnkrStats');
  await expect(f.page.locator('#usdcPool')).toHaveText('Unavailable');
  f.state.usdcPoolBalance='25000000';
  await f.page.click('#refreshBnkrStats');
  await expect(f.page.locator('#usdcPool')).toHaveText('0.00');
  assert.equal(f.state.sent.length,0);
 }finally{await f.close();}
});

test('stylesheet uses a content-versioned URL and matches its integrity hash',async()=>{
 const f=await fixture();try {
  const link=f.page.locator('link[rel="stylesheet"][href^="assets/"]');
  assert.match(await link.getAttribute('href'), /^assets\/vault\/style-[a-f0-9]{16}\.css$/);
  assert.match(await link.getAttribute('integrity'), /^sha384-/);
  await expect(f.page.locator('body')).not.toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  assert.equal(await f.page.evaluate(()=>window.cspViolations.length),0);
 }finally{await f.close();}
});
