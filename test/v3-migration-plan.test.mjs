import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeAbiParameters,getContractAddress} from 'viem';
import {createV3Plan,validateV3Plan,verifyV3Deployments,prepareV3Stage,serialize} from '../scripts/v3-migration.mjs';
const C={...JSON.parse(readFileSync('config/base.json')),...JSON.parse(readFileSync('config/v3-migration.json'))};
const A=JSON.parse(readFileSync('build/all.json'));
const deployer='0xa741dAd09fFF5de643283142eD339b9F0b52b146',minimum=60000n*10n**18n;
const limits={maxBnkrPerSwap:120000n*10n**18n,maxBnkrPer24Hours:240000n*10n**18n,minLiquidityBnkrWeth:10n**24n,minLiquidityWethUsdc:6n*10n**17n,minInterval:3600,slippageBps:50,maxTickDeviation:100,maxInputReserveBps:10};
const make=()=>createV3Plan(C,A,deployer,18n,minimum,limits);
test('five deterministic direct creations bind Safe ownership and reviewed limits',()=>{
 const p=make();assert.equal(p.deployments.length,5);assert.equal(p.safe.toLowerCase(),C.safe);
 for(let i=0;i<5;i++){
  const d=p.deployments[i];assert.equal(d.address,getContractAddress({from:deployer,nonce:18n+BigInt(i)}));
  assert.equal(d.value,'0');assert.equal(d.nonce,18+i);assert.equal(d.to,undefined);
  assert.ok(d.data.startsWith(A[d.name].bytecode));
 }
 assert.equal(p.reviewedLimits.slippageBps,'50');assert.equal(p.scope.includes('buybacks disabled'),true);
 validateV3Plan(C,A,JSON.parse(serialize(p)));
});
test('constructor arguments set the complete initial route without an initial setter batch',()=>{
 const p=make();assert.equal(p.version,3);
 const args=p.deployments.slice(0,2).map(d=>decodeAbiParameters(A[d.name].abi.find(x=>x.type==='constructor').inputs,'0x'+d.data.slice(A[d.name].bytecode.length)));
 assert.equal(args[0][3].toLowerCase(),C.safe);assert.equal(args[0][4].toLowerCase(),p.addresses.relay.toLowerCase());
 assert.equal(args[1][5].toLowerCase(),p.addresses.relay.toLowerCase());assert.equal(args[1][6].toLowerCase(),C.safe);
 assert.equal(args[1][8].toLowerCase(),p.addresses.keeper.toLowerCase());
 assert(p.scope.includes('future protected changes delayed 48 hours'));
 const keeper=p.deployments[3];
 const keeperArgs=decodeAbiParameters(A[keeper.name].abi.find(x=>x.type==='constructor').inputs,'0x'+keeper.data.slice(A[keeper.name].bytecode.length));
 assert.equal(keeperArgs[1].predecessor.toLowerCase(),C.oldKeeper.toLowerCase());
 for(const version of [1,2])assert.throws(()=>validateV3Plan(C,A,{...p,version}),/differs/);
});
test('obsolete schedule/wire stages are rejected before any RPC read',async()=>{
 for(const stage of ['schedule','wire'])await assert.rejects(prepareV3Stage({},C,A,make(),[],stage),/constructor-only/);
});
test('constructor bytes, sender, nonce and address substitutions are rejected',()=>{
 for(const change of ['data','from','nonce','address']){
  const p=make();p.deployments[0][change]=change==='nonce'?99:change==='data'?'0x1234':C.bankr;
  assert.throws(()=>validateV3Plan(C,A,p),/differs/);
 }
 const p=make();p.addresses.relay=C.bankr;assert.throws(()=>validateV3Plan(C,A,p),/differs/);
});
test('planner rejects unsupported authority, chain, nonce and weakened price bounds',()=>{
 for(const sender of [C.safe,C.bankr,'0x'+'0'.repeat(40)])assert.throws(()=>createV3Plan(C,A,sender,0,minimum,limits),/EOA/);
 assert.throws(()=>createV3Plan({...C,chainId:1},A,deployer,0,minimum,limits),/Base/);
 for(const nonce of [-1n,BigInt(Number.MAX_SAFE_INTEGER)])assert.throws(()=>createV3Plan(C,A,deployer,nonce,minimum,limits),/nonce/);
 for(const patch of [{slippageBps:101},{minInterval:899},{maxTickDeviation:101},{maxInputReserveBps:21},{maxBnkrPerSwap:1n},{maxBnkrPer24Hours:1n}])
  assert.throws(()=>createV3Plan(C,A,deployer,0,minimum,{...limits,...patch}),/Invalid/);
});
test('verification requires five unique actual receipts and the correct chain',async()=>{
 await assert.rejects(verifyV3Deployments({getChainId:async()=>1},C,A,make(),[]),/Base/);
 for(const hashes of [[],['0x1'],Array(5).fill('0x1')])await assert.rejects(verifyV3Deployments({getChainId:async()=>8453},C,A,make(),hashes),/Five distinct/);
});
