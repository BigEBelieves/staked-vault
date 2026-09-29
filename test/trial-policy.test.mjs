import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeFunctionData} from 'viem';
import {normalizeTrialPolicy, policyFloor, prepareTrialPolicy, readTrialReadiness} from '../scripts/trial-policy.mjs';
import {safeChecksum, ZERO} from '../scripts/deployment-plan.mjs';
const A = JSON.parse(readFileSync('build/all.json'));
const address = n => '0x' + n.toString(16).padStart(40,'0');
const C = {chainId:8453,safe:address(1),bankr:address(2),vault:address(3),distributor:address(4),usdc:address(5),weth:address(6),bnkr:address(7),staked:address(8),
  v3Router:address(9),poolManager:address(10),feeUsdcWeth:500,feeWethBnkr:10000,v3Quoter:address(11),v4Quoter:address(12),stateView:address(13),
  poolId:'0x'+'33'.repeat(32),poolKey:{currency0:address(7),currency1:address(8),fee:8388608,tickSpacing:200,hooks:address(14)}};
const H = {guard:address(15),executor:address(16),relay:address(17)};
const input = () => ({distribution:{amountIn:'1000',amountOut:'1000'},buybackV3:{amountIn:'1000000',amountOut:'1000'},buybackTotal:{amountIn:'1000000',amountOut:'2000'},
  maxBnkrPerSwap:'1000',maxUsdcPerBuyback:'1000000',bnkrBudget:'1000',usdcBudget:'1000000',sqrtPriceLimitX96:'995000000000',slippageBps:50});
const options = p => ({config:C,artifacts:A,helpers:H,policy:p ?? input()});
function fixture({queue=1000n,reserve=1000000n,minimumBatch=100n,changed=false,overrides={},distQuote=1000n,simulationFails=false} = {}) {
  const calls=[];let heads=0;
  function result(c) {
    calls.push(c);
    if (c.functionName in overrides) return overrides[c.functionName];
    const common = {pendingSwapBnkr:queue,minBnkrBatch:minimumBatch,buybackReserve:reserve,paused:true,remainingBnkr:0n,remainingUsdc:0n,operator:C.bankr,
      safe:C.safe,owner:C.safe,pendingOwner:ZERO,keeper:H.guard,executor:H.executor,buybackExecutor:H.executor,
      liquidityWallet:C.safe,bnkrStakingWallet:C.safe,swapRouter:C.v3Router,router:C.v3Router,poolManager:C.poolManager,
      bnkrWethFee:C.feeWethBnkr,wethUsdcFee:C.feeUsdcWeth,feeUsdcWeth:C.feeUsdcWeth,feeWethBnkr:C.feeWethBnkr,
      usdc:C.usdc,weth:C.weth,bnkr:C.bnkr,staked:C.staked,guard:H.guard,
      poolKey:Object.values(C.poolKey),bnkrIsCurrency0:true,getOwners:[address(30),address(31),address(32)],getThreshold:2n,nonce:7n,
      swapPath:'0x1234',getSlot0:[1000000000000n,0,0,0]};
    if (c.functionName === 'vault') return c.address === C.distributor ? H.relay : C.vault;
    if (c.functionName === 'distributor') return c.address === C.vault ? H.relay : C.distributor;
    assert(c.functionName in common,'Unknown mock read '+c.functionName);
    return common[c.functionName];
  }
  return {calls,getChainId:async()=>8453,
    getBlock:async ({blockNumber}={}) => ({number:changed && !blockNumber && ++heads>1 ? 101n : 100n,timestamp:1800000000n,hash:'0x'+'11'.repeat(32)}),
    getBytecode:async ({address:a}) => a === H.guard ? A.StakedAutomationGuard.deployedBytecode : a === H.executor ? A.StakedBoundedBuybackExecutor.deployedBytecode : '0x1234',
    multicall:async c => c.contracts.map(x=>result({...x,blockNumber:c.blockNumber})), readContract:async c => result(c),
    simulateContract:async c => {
      calls.push(c);
      if(c.functionName==='quoteExactInput') return {result:[c.args[0]==='0x1234'?distQuote:1000n,[],[],0n]};
      if(c.functionName==='quoteExactInputSingle') return {result:[2000n,0n]};
      assert.equal(c.functionName,'setPolicy');assert.equal(c.account,C.safe);
      if(simulationFails) throw new Error('policy reverted');
      return {};
    }
  };
}

test('unsigned trial contains only setPolicy and leaves unpause out', async () => {
  const client=fixture();const result=await prepareTrialPolicy(client,options());
  assert.equal(result.batch.transactions.length,1);
  const tx=result.batch.transactions[0];
  assert.equal(tx.to,H.guard);assert.equal(tx.value,'0');
  const decoded=decodeFunctionData({abi:A.StakedAutomationGuard.abi,data:tx.data});
  assert.equal(decoded.functionName,'setPolicy');
  assert.equal(decoded.args[0].bnkrBudget,1000n);assert.equal(decoded.args[0].usdcBudget,1000000n);
  assert.equal(decoded.args[0].validUntil,1800001800);
  assert.equal(result.batch.meta.checksum,safeChecksum(result.batch));
  assert(client.calls.every(c=>c.blockNumber===100n));
});

test('unfunded directions and a changed queue produce no policy payload or quote', async () => {
  for(const [settings,reason] of [[{queue:1n},/minimum batch/],[{reserve:0n},/reserve/],[{queue:1100n},/exact full BNKR queue/]]) {
    const client=fixture(settings);
    await assert.rejects(prepareTrialPolicy(client,options()),reason);
    assert(!client.calls.some(c=>c.functionName==='quoteExactInput'));
  }
  const policy=input();policy.usdcBudget='0';
  const result=await prepareTrialPolicy(fixture({reserve:0n}),options(policy));
  assert.equal(result.policy.usdcBudget,0n);
  assert(!result.quotes.buybackV3);
});

test('readiness reports insufficient funds and does not prepare any signing payload', async () => {
  const client=fixture({queue:1n,reserve:0n});
  const result=await readTrialReadiness(client,options());
  assert.equal(result.distributionFunded,false);assert.equal(result.buybackFunded,false);
  assert.equal(result.signingPayloadPrepared,false);assert.equal(result.liveTransactionSent,false);
  assert.equal(result.blockers.length,2);
  assert(!client.calls.some(c=>c.functionName==='setPolicy'));
});

test('invalid raw units, excessive slippage/window and unbounded budgets are rejected', () => {
  for(const mutate of [p=>p.bnkrBudget=1000,p=>p.bnkrBudget='1e3',p=>p.distribution.amountOut='0',p=>p.maxUsdcPerBuyback='-1',
    p=>p.slippageBps=101,p=>p.bnkrBudget='2000',p=>p.distribution.amountIn='999',p=>p.buybackTotal.amountIn='999',
    p=>p.sqrtPriceLimitX96='4295128740',p=>{p.bnkrBudget='0';p.usdcBudget='0';}]) {
    const p=input();mutate(p);assert.throws(()=>normalizeTrialPolicy(p,1800000000n));
  }
  assert.throws(()=>normalizeTrialPolicy(input(),1800000000n,3601),/Window/);
  assert.throws(()=>normalizeTrialPolicy(input(),1800000000n,0),/Window/);
  assert.equal(policyFloor(1n,{amountIn:3n,amountOut:4n},100),2n);
});

test('stale references, distant or wrong-direction v4 limits and changed authority stop preparation', async () => {
  for(const [settings,reason] of [[{distQuote:1100n},/more than 1%/],[{distQuote:900n},/exceeds current quote/],
    [{overrides:{owner:address(99)}},/owner/],[{overrides:{getThreshold:1n}},/2-of-3/],[{overrides:{operator:ZERO}},/operator/],
    [{overrides:{remainingBnkr:1n}},/remainingBnkr/],[{simulationFails:true},/policy reverted/],[{changed:true},/Head changed/]])
    await assert.rejects(prepareTrialPolicy(fixture(settings),options()),reason);
  for(const [sqrt,reason] of [['994000000000',/more than 1%/],['1001000000000',/wrong side/]]) {
    const p=input();p.sqrtPriceLimitX96=sqrt;
    await assert.rejects(prepareTrialPolicy(fixture(),options(p)),reason);
  }
});
