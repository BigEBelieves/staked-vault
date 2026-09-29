import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData } from 'viem';
import { readFileSync } from 'node:fs';
import { quoteMinimum, prepareKeeper, revalidateKeeper } from '../scripts/keeper-plan.mjs';
const artifacts = JSON.parse(readFileSync('build/all.json'));
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const guard = address(1), v3Quoter = address(2), operator = address(3);
const options = { mode: 'distribute', guard, v3Quoter };
function fixture({ changed = false, wrongChain = false, floor = 995n, simulationFails = false, overrides = {} } = {}) {
  const calls = []; let heads = 0;
  return { calls,
    getChainId: async () => wrongChain ? 1 : 8453,
    getBytecode: async () => '0x1234',
    getBlock: async () => ({ number: ++heads > 1 && changed ? 101n : 100n, timestamp: 1800000000n, hash: '0x' + '11'.repeat(32) }),
    readContract: async call => {
      calls.push(call);
      return { operator, nonce: 5n, distributor: address(4), pendingSwapBnkr: 1000n, minBnkrBatch: 100n, swapPath: '0x1234', distributionFloor: floor,
        paused:false, policy:[{amountIn:1000n,amountOut:1000n},{amountIn:1000000n,amountOut:1000n},{amountIn:1000000n,amountOut:2000n},1000n,1000000n,1000n,1000000n,1n,1800003600,50],
        remainingBnkr:1000n, remainingUsdc:1000000n, vault:address(12), buybackReserve:1000000n, ...overrides }[call.functionName];
    },
    simulateContract: async call => {
      calls.push(call);
      if (call.functionName === 'quoteExactInput') return {result: [1000n, [], [], 0n]};
      if (simulationFails) throw new Error('simulation reverted');
      return {};
    }
  };
}
test('slippage is capped at 1% and minimum rounds up', () => {
  assert.equal(quoteMinimum(10000n), 9950n);
  assert.equal(quoteMinimum(1n, 100), 1n);
  for (const bps of [101, -1, NaN, 1.5]) assert.throws(() => quoteMinimum(100n, bps));
  assert.throws(() => quoteMinimum(0n));
});
test('quotes and simulation share one block; stricter Safe floor wins', async () => {
  const client = fixture({floor: 999n});
  const plan = await prepareKeeper(client, options);
  const decoded = decodeFunctionData({abi: artifacts.StakedAutomationGuard.abi, data: plan.data});
  assert.equal(decoded.functionName, 'swapAndNotify');
  assert.deepEqual(decoded.args, [1000n, 999n, 100n, 1800000030, 5n]);
  assert.equal(plan.from, operator);
  assert(client.calls.every(call => call.blockNumber === 100n));
});
test('fresh-quote minimum wins over a weaker Safe floor', async () => {
  const plan = await prepareKeeper(fixture({floor: 1n}), options);
  assert.equal(plan.quotes.minimumUsdc, 995n);
});
test('changed head, wrong chain, failed simulation and excessive slippage produce no plan', async () => {
  await assert.rejects(prepareKeeper(fixture({changed: true}), options), /Head changed/);
  await assert.rejects(prepareKeeper(fixture({wrongChain: true}), options), /Base mainnet/);
  await assert.rejects(prepareKeeper(fixture({simulationFails: true}), options), /simulation reverted/);
  await assert.rejects(prepareKeeper(fixture(), {...options, slippageBps: 500}), /0–100/);
});
test('buyback binds both leg floors and quotes v4 using quoted BNKR input', async () => {
  const client = fixture();
  const pinnedRead = client.readContract;
  client.readContract = async call => {
    if (['operator', 'nonce', 'paused', 'policy', 'remainingBnkr', 'remainingUsdc', 'vault', 'buybackReserve'].includes(call.functionName)) return pinnedRead(call);
    client.calls.push(call);
    return {
      executor: address(5), usdc: address(6), weth: address(7), bnkr: address(8),
      feeUsdcWeth: 500, feeWethBnkr: 10000,
      poolKey: [address(8), address(9), 8388608, 200, address(10)], bnkrIsCurrency0: true,
      buybackV3Floor: 999n, buybackFloor: 1900n
    }[call.functionName];
  };
  client.simulateContract = async call => {
    client.calls.push(call);
    if (call.functionName === 'quoteExactInput') return {result: [1000n, [], [], 0n]};
    if (call.functionName === 'quoteExactInputSingle') {
      assert.equal(call.args[0].exactAmount, 1000n);
      assert.equal(call.args[0].zeroForOne, true);
      return {result: [2000n, 0n]};
    }
    return {};
  };
  const plan = await prepareKeeper(client, {...options, mode: 'buyback', amount: 1000000n, v4Quoter: address(11)});
  const decoded = decodeFunctionData({abi: artifacts.StakedAutomationGuard.abi, data: plan.data});
  assert.equal(decoded.functionName, 'executeBuyback');
  assert.deepEqual(decoded.args, [1000000n, 999n, 1990n, 100n, 1800000030, 5n]);
  assert(client.calls.every(call => call.blockNumber === 100n));
});

test('preparation stops before quotes for pause, expiry, dust queue and insufficient budgets', async () => {
  for (const [overrides, reason] of [
    [{paused:true}, /paused/], [{minBnkrBatch:1001n}, /minimum batch/], [{remainingBnkr:999n}, /remaining budget/],
    [{policy:[0,0,0,999n,1000000n,0,0,0,1800003600,50]}, /policy cap/],
    [{policy:[0,0,0,1000n,1000000n,0,0,0,1800000000,50]}, /expired/]
  ]) {
    const client = fixture({overrides});
    await assert.rejects(prepareKeeper(client,options),reason);
    assert(!client.calls.some(c => c.functionName === 'quoteExactInput'));
  }
  await assert.rejects(prepareKeeper(fixture({overrides:{buybackReserve:0n}}), {...options,mode:'buyback',amount:1n,v4Quoter:address(11)}), /reserve/);
});

test('final validation catches signing delays, reorgs, nonce changes, queue changes and changed authority', async () => {
  const plan = await prepareKeeper(fixture(), options);
  const limits = {guard, operator};
  const ok = await revalidateKeeper(fixture(), plan, limits);
  assert.equal(ok.broadcast, false);
  for (const [overrides,reason] of [[{nonce:6n},/nonce changed/],[{pendingSwapBnkr:1001n},/queue changed/],[{paused:true},/paused/],[{operator:address(99)},/Operator changed/]])
    await assert.rejects(revalidateKeeper(fixture({overrides}),plan,limits),reason);
  const delayed = fixture();
  delayed.getBlock = async () => ({number:103n,timestamp:1800000006n,hash:plan.quoteBlockHash});
  await assert.rejects(revalidateKeeper(delayed,plan,limits), /Stale quote/);
  const expired = fixture();
  expired.getBlock = async () => ({number:102n,timestamp:1800000031n,hash:plan.quoteBlockHash});
  await assert.rejects(revalidateKeeper(expired,plan,limits), /deadline/);
  const reorg = fixture();
  reorg.getBlock = async () => ({number:100n,timestamp:1800000000n,hash:'0x'+'22'.repeat(32)});
  await assert.rejects(revalidateKeeper(reorg,plan,limits), /reorganized/);
  await assert.rejects(revalidateKeeper(fixture(),{...plan,value:'1'},limits), /value/);
  await assert.rejects(revalidateKeeper(fixture(),{...plan,to:address(99)},limits), /destination/);
  await assert.rejects(revalidateKeeper(fixture(),{...plan,quoteBlock:99n},limits), /metadata/);
  await assert.rejects(revalidateKeeper(fixture({simulationFails:true}),plan,limits), /simulation reverted/);
  await assert.rejects(revalidateKeeper(fixture({changed:true}),plan,limits), /Head changed/);
});
