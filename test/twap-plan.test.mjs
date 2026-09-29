import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData} from 'viem';
import {readFileSync} from 'node:fs';
import {prepareTwapKeeper,revalidateTwapKeeper} from '../scripts/twap-keeper-plan.mjs';
const A=JSON.parse(readFileSync('build/all.json'));
const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const o={keeper:addr(1),safe:addr(2),operator:addr(3),distributor:addr(4),v3Quoter:addr(5)};
const hash='0x'+'12'.repeat(32),timestamp=1800000000n;
function fixture(overrides={}) {
 const calls=[];
 return {calls,getChainId:async()=>8453,getBytecode:async()=>'0x1234',
  getBlock:async({blockNumber}={})=>({number:blockNumber??100n,timestamp,hash}),
  readContract:async q=>{calls.push(q);return {safe:o.safe,operator:o.operator,distributor:o.distributor,
   paused:false,nonce:3n,limits:[1000n,2000n,1n,1n,900,50,100,10],spentLast24Hours:0n,lastExecution:0,
   pendingSwapBnkr:1000n,minBnkrBatch:100n,swapPath:'0x1234',minimumUsdc:999n,...overrides}[q.functionName];},
  simulateContract:async q=>{calls.push(q);return {result:q.functionName==='quoteExactInput'?[1000n,[],[],0n]:1000n};}
 };
}
test('fixed sender and destination; stricter floor wins; no sending capability',async()=>{
 const client=fixture(),p=await prepareTwapKeeper(client,o);
 assert.deepEqual(decodeFunctionData({abi:A.StakedTwapKeeper.abi,data:p.data}).args,[1000n,999n,Number(timestamp+60n),3n]);
 assert.equal(p.from,o.operator);assert.equal(p.to,o.keeper);assert.equal(p.value,'0x0');
 assert(client.calls.every(c=>c.blockNumber===100n));
 assert.equal((await revalidateTwapKeeper(client,p,o)).broadcast,false);
 const loose=await prepareTwapKeeper(fixture({minimumUsdc:900n}),o);assert.equal(loose.quotes.minimumUsdc,995n);
});
test('preflight rejects changed identities, pause, dust, caps and cooldown',async()=>{
 for(const [change,reason] of [[{safe:addr(99)},/identity/],[{operator:addr(99)},/identity/],[{distributor:addr(99)},/identity/],
  [{paused:true},/paused/],[{pendingSwapBnkr:0n},/threshold/],[{minBnkrBatch:1001n},/threshold/],
  [{pendingSwapBnkr:1001n},/cap/],[{spentLast24Hours:1001n},/cap/],[{lastExecution:Number(timestamp)},/Cooldown/]]) {
  const client=fixture(change);await assert.rejects(prepareTwapKeeper(client,o),reason);
  assert(!client.calls.some(c=>c.functionName==='quoteExactInput'));
 }
});
test('fresh state, canonical block and exact calldata are checked before submission',async()=>{
 const p=await prepareTwapKeeper(fixture(),o);
 for(const [change,reason] of [[{nonce:4n},/nonce changed/],[{pendingSwapBnkr:999n},/Queue or nonce/],[{minimumUsdc:1000n},/TWAP floor/]])
  await assert.rejects(revalidateTwapKeeper(fixture(change),p,o),reason);
 for(const change of [{to:addr(9)},{from:addr(9)},{value:'1'}])await assert.rejects(revalidateTwapKeeper(fixture(),{...p,...change},o),/Unexpected transaction/);
 await assert.rejects(revalidateTwapKeeper(fixture(),{...p,keeperNonce:4n},o),/metadata/);
 await assert.rejects(revalidateTwapKeeper(fixture(),{...p,data:p.data+'00'},o),/calldata/);
 const delayed=fixture();delayed.getBlock=async({blockNumber}={})=>({number:blockNumber??108n,timestamp:timestamp+(blockNumber?0n:16n),hash});
 await assert.rejects(revalidateTwapKeeper(delayed,p,o),/stale/);
 const reorg=fixture();reorg.getBlock=async()=>({number:100n,timestamp,hash:'0x'+'34'.repeat(32)});
 await assert.rejects(revalidateTwapKeeper(reorg,p,o),/block changed/);
 const failed=fixture();failed.simulateContract=async()=>{throw new Error('execution reverted');};
 await assert.rejects(revalidateTwapKeeper(failed,p,o),/execution reverted/);
});
test('advancing normal blocks are allowed within freshness and deadline bounds',async()=>{
 const p=await prepareTwapKeeper(fixture(),o),c=fixture();
 c.getBlock=async({blockNumber}={})=>({number:blockNumber??103n,timestamp:timestamp+(blockNumber===100n?0n:6n),hash});
 assert.equal((await revalidateTwapKeeper(c,p,o)).broadcast,false);
});
