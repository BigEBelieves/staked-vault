import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData} from 'viem';
import {readFileSync} from 'node:fs';
import {prepareTwapKeeperV3,revalidateTwapKeeperV3} from '../scripts/twap-keeper-v3-plan.mjs';
const A=JSON.parse(readFileSync('build/all.json'));
const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const o={keeper:addr(1),safe:addr(2),operator:addr(3),distributor:addr(4),v3Quoter:addr(5)};
const hash='0x'+'12'.repeat(32),timestamp=1800000000n;
function fixture(overrides={}) {
 const calls=[];
 return {calls,getChainId:async()=>8453,getBytecode:async()=>'0x1234',
  getBlock:async({blockNumber}={})=>({number:blockNumber??100n,timestamp,hash}),
  readContract:async q=>{calls.push(q);return {safe:o.safe,operator:o.operator,distributor:o.distributor,
   paused:false,nonce:3n,limits:[1000n,2000n,1n,1n,900,50,100,10],spentLast24Hours:0n,effectiveLastExecution:0,
   batchSwapVersion:1n,pendingSwapBnkr:1000n,minBnkrBatch:100n,swapPath:'0x1234',minimumUsdc:999n,...overrides}[q.functionName];},
  simulateContract:async q=>{calls.push(q);return {result:q.functionName==='quoteExactInput'?[1000n,[],[],0n]:1000n};}
 };
}
test('fixed sender and destination; stricter floor wins; no sending capability',async()=>{
 const client=fixture(),p=await prepareTwapKeeperV3(client,o);
 assert.deepEqual(decodeFunctionData({abi:A.StakedTwapKeeperV3.abi,data:p.data}).args,[1000n,999n,Number(timestamp+60n),3n]);
 assert.equal(p.from,o.operator);assert.equal(p.to,o.keeper);assert.equal(p.value,'0x0');
 assert(client.calls.every(c=>c.blockNumber===100n));
 assert.equal((await revalidateTwapKeeperV3(client,p,o)).broadcast,false);
 const loose=await prepareTwapKeeperV3(fixture({minimumUsdc:900n}),o);assert.equal(loose.quotes.minimumUsdc,995n);
});
test('preflight rejects changed identities, pause, dust, caps and cooldown',async()=>{
 for(const [change,reason] of [[{safe:addr(99)},/identity/],[{operator:addr(99)},/identity/],[{distributor:addr(99)},/identity/],
  [{paused:true},/paused/],[{pendingSwapBnkr:0n},/threshold/],[{minBnkrBatch:1001n},/threshold/],
  [{batchSwapVersion:0n},/V3/],[{spentLast24Hours:1950n},/cap/],[{effectiveLastExecution:Number(timestamp)},/Cooldown/]]) {
  const client=fixture(change);await assert.rejects(prepareTwapKeeperV3(client,o),reason);
  assert(!client.calls.some(c=>c.functionName==='quoteExactInput'));
 }
});
test('fresh state, canonical block and exact calldata are checked before submission',async()=>{
 const p=await prepareTwapKeeperV3(fixture(),o);
 for(const [change,reason] of [[{nonce:4n},/nonce changed/],[{pendingSwapBnkr:999n},/available queue/],[{minimumUsdc:1000n},/TWAP floor/]])
  await assert.rejects(revalidateTwapKeeperV3(fixture(change),p,o),reason);
 for(const change of [{to:addr(9)},{from:addr(9)},{value:'1'}])await assert.rejects(revalidateTwapKeeperV3(fixture(),{...p,...change},o),/Unexpected transaction/);
 await assert.rejects(revalidateTwapKeeperV3(fixture(),{...p,keeperNonce:4n},o),/metadata/);
 await assert.rejects(revalidateTwapKeeperV3(fixture(),{...p,data:p.data+'00'},o),/calldata/);
 const delayed=fixture();delayed.getBlock=async({blockNumber}={})=>({number:blockNumber??108n,timestamp:timestamp+(blockNumber?0n:16n),hash});
 await assert.rejects(revalidateTwapKeeperV3(delayed,p,o),/stale/);
 const reorg=fixture();reorg.getBlock=async()=>({number:100n,timestamp,hash:'0x'+'34'.repeat(32)});
 await assert.rejects(revalidateTwapKeeperV3(reorg,p,o),/block changed/);
 const failed=fixture();failed.simulateContract=async()=>{throw new Error('execution reverted');};
 await assert.rejects(revalidateTwapKeeperV3(failed,p,o),/execution reverted/);
});
test('advancing normal blocks are allowed within freshness and deadline bounds',async()=>{
 const p=await prepareTwapKeeperV3(fixture(),o),c=fixture();
 c.getBlock=async({blockNumber}={})=>({number:blockNumber??103n,timestamp:timestamp+(blockNumber===100n?0n:6n),hash});
 assert.equal((await revalidateTwapKeeperV3(c,p,o)).broadcast,false);
});

test('queue growth does not invalidate a prepared input and oversized queue uses caps',async()=>{
 const p=await prepareTwapKeeperV3(fixture(),o);
 assert.equal((await revalidateTwapKeeperV3(fixture({pendingSwapBnkr:1001n}),p,o)).broadcast,false);
 const big=await prepareTwapKeeperV3(fixture({pendingSwapBnkr:1000000n}),o);
 assert.equal(big.quotes.bnkrIn,1000n);assert.equal(big.quotes.queuedBnkr,1000000n);
 const budget=await prepareTwapKeeperV3(fixture({spentLast24Hours:1700n}),o);assert.equal(budget.quotes.bnkrIn,300n);
 const lower=await prepareTwapKeeperV3(fixture(),{...o,maxBnkrPerBatch:'200'});assert.equal(lower.quotes.bnkrIn,200n);
 await assert.rejects(prepareTwapKeeperV3(fixture(),{...o,maxBnkrPerBatch:'0'}),/Invalid/);
 await assert.rejects(prepareTwapKeeperV3(fixture(),{...o,maxBnkrPerBatch:'99'}),/threshold/);
});
test('revalidation keeps signed input fixed after queue and budget changes',async()=>{
 const p=await prepareTwapKeeperV3(fixture({pendingSwapBnkr:500n}),o);
 await revalidateTwapKeeperV3(fixture({pendingSwapBnkr:1000000n}),p,o);
 await assert.rejects(revalidateTwapKeeperV3(fixture({spentLast24Hours:1600n}),p,o),/cap/);
 await assert.rejects(revalidateTwapKeeperV3(fixture(),{...p,quotes:{...p.quotes,bnkrIn:499n}},o),/metadata/);
 await assert.rejects(revalidateTwapKeeperV3(fixture(),{...p,quotes:{...p.quotes,minimumUsdc:1n}},o),/metadata/);
});
