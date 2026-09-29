import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData } from 'viem';
import { readFileSync } from 'node:fs';
import { quoteMinimum, prepareKeeper } from '../scripts/keeper-plan.mjs';
const artifacts = JSON.parse(readFileSync('build/all.json'));
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const guard = address(1), v3Quoter = address(2), operator = address(3);
const options = { mode: 'distribute', guard, v3Quoter };
function fixture({ changed = false, wrongChain = false, floor = 995n, simulationFails = false } = {}) {
  const calls = []; let heads = 0;
  return { calls,
    getChainId: async () => wrongChain ? 1 : 8453,
    getBytecode: async () => '0x1234',
    getBlock: async () => ({ number: ++heads > 1 && changed ? 101n : 100n, timestamp: 1800000000n, hash: '0x' + '11'.repeat(32) }),
    readContract: async call => {
      calls.push(call);
      return { operator, nonce: 5n, distributor: address(4), pendingSwapBnkr: 1000n, swapPath: '0x1234', distributionFloor: floor }[call.functionName];
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
    if (['operator', 'nonce'].includes(call.functionName)) return pinnedRead(call);
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
