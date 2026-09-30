import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DeploymentSession,hex} from '../bnkr-deployment/engine.mjs';
import {payloadSha256} from '../bnkr-deployment/payload-digest.mjs';
const bytes=readFileSync('bnkr-deployment/payload.json','utf8'),payload=JSON.parse(bytes);
const blockHash='0x'+'a'.repeat(64),other='0x'+'b'.repeat(40);
function fixture(count=1){
 const p=structuredClone(payload),calls=[],values=new Map();
 p.plan.deployments=p.plan.deployments.slice(0,count);p.verification=p.verification.slice(0,count);
 const state={chain:'0x2105',account:p.plan.deployer,nonce:BigInt(p.plan.firstNonce),pending:null,balance:10n**18n,
  delegation:'0x',head:102n,txs:new Map(),receipts:new Map(),codes:new Map(),calls,sendError:null,revertSimulation:false,badRuntime:false,badGetter:false};
 const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const provider={async request({method,params=[]}){
  calls.push({method,params});
  const [arg]=params;
  if(method==='eth_chainId')return state.chain;
  if(method==='eth_accounts')return[state.account];
  if(method==='eth_getCode')return arg.toLowerCase()===p.plan.deployer.toLowerCase()?state.delegation:(state.codes.get(arg.toLowerCase())??'0x');
  if(method==='eth_getTransactionCount')return hex(params[1]==='pending'?(state.pending??state.nonce):state.nonce);
  if(method==='eth_getBlockByNumber')return{number:arg==='latest'?hex(state.head):arg,hash:blockHash};
  if(method==='eth_getTransactionReceipt')return state.receipts.get(arg)??null;
  if(method==='eth_getTransactionByHash')return state.txs.get(arg)??null;
  if(method==='eth_getBalance')return hex(state.balance);
  if(method==='eth_estimateGas')return hex(1000000);
  if(method==='eth_gasPrice')return hex(6000000);
  if(method==='eth_maxPriorityFeePerGas')return hex(1000000);
  if(method==='eth_call'){
   if(!arg.to){if(state.revertSimulation)throw new Error('constructor reverted');const i=p.plan.deployments.findIndex(d=>d.data===arg.data);return state.badRuntime?'0x00':p.verification[i].code;}
   if(arg.to===p.gasOracle)return hex(100000000000);
   const i=p.plan.deployments.findIndex(d=>d.address.toLowerCase()===arg.to.toLowerCase());
   if(state.badGetter)return '0x'+'0'.repeat(64);
   return p.verification[i].calls.find(c=>c.data===arg.data).expected;
  }
  if(method==='eth_sendTransaction'){
   if(state.sendError)throw state.sendError;
   const i=p.plan.deployments.findIndex(d=>d.nonce===Number(BigInt(arg.nonce)));
   const hash='0x'+String(i+1).padStart(64,'0'),d=p.plan.deployments[i];state.nonce++;
   state.txs.set(hash,{...arg,to:null,input:arg.data});
   state.receipts.set(hash,{status:'0x1',contractAddress:d.address,blockNumber:'0x65',blockHash});
   state.codes.set(d.address.toLowerCase(),p.verification[i].code);return hash;
  }
  throw new Error('Unexpected method: '+method);
 }};
 return {session:new DeploymentSession(provider,p,storage,'test'),state,storage,provider,p};
}
test('published payload has the pinned digest and exact plan-only creations',()=>{
 assert.equal(createHash('sha256').update(bytes).digest('hex'),payloadSha256);
 assert.equal(payload.plan.deployments.length,1);
 for(const d of payload.plan.deployments){assert.equal(d.value,'0');assert.equal(d.to,undefined);}
});
test('inspection and simulation do not open a transaction request',async()=>{
 const {session,state}=fixture();assert.equal((await session.inspect()).status,'ready');await session.prepare();
 assert(!state.calls.some(c=>c.method==='eth_sendTransaction'));
});
test('each explicit send creates one contract, then verifies before the next step',async()=>{
 const {session,state,p}=fixture();
 for(let i=0;i<1;i++){
  const sent=await session.sendNext();assert.equal(sent.index,i);
  const request=state.calls.filter(c=>c.method==='eth_sendTransaction').at(-1).params[0];
  assert.equal(request.to,undefined);assert.equal(request.value,'0x0');assert.equal(request.data,p.plan.deployments[i].data);
  assert.equal(request.nonce,hex(p.plan.deployments[i].nonce));assert.equal(request.from,p.plan.deployer);
 }
 assert.equal((await session.inspect()).status,'complete');
 await assert.rejects(session.sendNext(),/Complete or recover/);
 assert.equal(state.calls.filter(c=>c.method==='eth_sendTransaction').length,1);
});
test('wrong wallet, wrong chain and delegated account all block signing',async()=>{
 for(const [key,value,pattern]of[['account',other,/Select the deployment account/],['chain','0x1',/Select Base/],['delegation','0xef0100',/delegated/]]){
  const {session,state}=fixture();state[key]=value;await assert.rejects(session.sendNext(),pattern);
  assert(!state.calls.some(c=>c.method==='eth_sendTransaction'));
 }
});
test('changed or pending nonce blocks signing',async()=>{
 for(const key of ['nonce','pending']){const{session,state}=fixture();state[key]=BigInt(payload.plan.firstNonce)+1n;
  await assert.rejects(session.sendNext(),/nonce changed/);assert(!state.calls.some(c=>c.method==='eth_sendTransaction'));
 }
});
test('constructor revert, wrong simulation code and insufficient gas balance block signing',async()=>{
 for(const [key,value,pattern]of[['revertSimulation',true,/constructor reverted/],['badRuntime',true,/unexpected length/],['balance',0n,/Insufficient ETH/]]){
  const{session,state}=fixture();state[key]=value;await assert.rejects(session.sendNext(),pattern);
  assert(!state.calls.some(c=>c.method==='eth_sendTransaction'));
 }
});
test('pending and insufficiently confirmed receipts block the next creation',async()=>{
 const{session,state}=fixture();const{hash}=await session.sendNext();const receipt=state.receipts.get(hash);
 state.receipts.delete(hash);assert.equal((await session.inspect()).status,'pending');await assert.rejects(session.sendNext(),/Complete or recover/);
 state.receipts.set(hash,receipt);state.head=101n;assert.equal((await session.inspect()).status,'confirming');
});
test('wrong creation sender, nonce, calldata, value and destination are rejected',async()=>{
 for(const change of [{from:other},{nonce:'0x0'},{input:'0x1234'},{value:'0x1'},{to:other}]){
  const{session,state}=fixture();const{hash}=await session.sendNext();Object.assign(state.txs.get(hash),change);
  await assert.rejects(session.inspect(),/exact planned creation/);
 }
});
test('failed receipt, wrong address, bad code and changed settings are rejected',async()=>{
 for(const mode of ['status','address','code','getter']){
  const{session,state,p}=fixture();const{hash}=await session.sendNext();
  if(mode==='status')state.receipts.get(hash).status='0x0';
  if(mode==='address')state.receipts.get(hash).contractAddress=other;
  if(mode==='code')state.codes.set(p.plan.deployments[0].address.toLowerCase(),'0xff'+p.verification[0].code.slice(4));
  if(mode==='getter')state.badGetter=true;
  await assert.rejects(session.inspect(),/reverted|Unexpected deployed address|does not match/);
 }
});
test('explicit wallet rejection can retry, ambiguous errors persistently block retries',async()=>{
 const a=fixture();a.state.sendError=Object.assign(new Error('rejected'),{code:4001});await assert.rejects(a.session.sendNext(),/rejected/);
 assert.equal((await a.session.inspect()).status,'ready');
 const b=fixture();b.state.sendError=new Error('network disconnected');await assert.rejects(b.session.sendNext(),/network disconnected/);
 const reloaded=new DeploymentSession(b.provider,b.p,b.storage,'test');assert.equal((await reloaded.inspect()).status,'uncertain');
 await assert.rejects(reloaded.sendNext(),/Complete or recover/);assert.equal(b.state.calls.filter(c=>c.method==='eth_sendTransaction').length,1);
});
test('recovery accepts only the exact confirmed creation',async()=>{
 const{session,state}=fixture();const{hash}=await session.sendNext();session.saved.hashes[0]=null;session.saved.uncertain[0]=true;session.save();
 await assert.rejects(session.recover(0,'0x'+'f'.repeat(64)),/must be confirmed/);
 await session.recover(0,hash);assert.equal((await session.inspect()).index,1);assert.equal(session.saved.uncertain[0],false);
 state.txs.get(hash).input='0x00';await assert.rejects(session.recover(0,hash),/exact planned creation/);
});
test('storage failure prevents opening a signing request',async()=>{
 const{session,state,storage}=fixture();storage.setItem=()=>{throw new Error('storage unavailable');};
 await assert.rejects(session.sendNext(),/storage unavailable/);assert(!state.calls.some(c=>c.method==='eth_sendTransaction'));
});
test('duplicate calls in one session cannot open concurrent wallet requests',async()=>{
 const{session,state}=fixture();const first=session.sendNext();await assert.rejects(session.sendNext(),/already open/);await first;
 assert.equal(state.calls.filter(c=>c.method==='eth_sendTransaction').length,1);
});
test('single-helper plans complete after one verified creation and cannot repeat',async()=>{
 const {session,state}=fixture(1);
 await session.sendNext();assert.equal((await session.inspect()).status,'complete');
 await assert.rejects(session.sendNext(),/Complete or recover/);
 await assert.rejects(session.recover(1,'0x'+'1'.repeat(64)),/complete Base/);
 assert.equal(state.calls.filter(c=>c.method==='eth_sendTransaction').length,1);
});
