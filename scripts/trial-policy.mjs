// Unsigned first-window preparation. No signer, unpause call, token funding or sender.
import assert from 'node:assert/strict';
import { encodeFunctionData, encodePacked, getAddress, parseAbi } from 'viem';
import { assertRuntime, safeChecksum, ZERO } from './deployment-plan.mjs';
import { quoteMinimum, v3Quoter, v4Quoter } from './keeper-plan.mjs';

const U128 = (1n << 128n) - 1n;
const MIN_SQRT = 4295128740n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
const safeAbi = parseAbi(['function getOwners() view returns(address[])', 'function getThreshold() view returns(uint256)', 'function nonce() view returns(uint256)']);
const stateAbi = parseAbi(['function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)']);
const ceil = (n, d) => (n + d - 1n) / d;
const same = (a, b, label) => assert.equal(typeof a === 'string' ? a.toLowerCase() : a, typeof b === 'string' ? b.toLowerCase() : b, label);
function uint(value, label, positive = false) {
  assert(typeof value === 'bigint' || (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)), label + ': use an integer string in raw token units');
  const n = BigInt(value);
  assert(n >= (positive ? 1n : 0n) && n <= U128, label + ': outside uint128');
  return n;
}

// Mirror the contract's two round-up operations, including intermediate uint128 bound.
export function policyFloor(amount, reference, slippageBps) {
  const quoted = ceil(amount * reference.amountOut, reference.amountIn);
  assert(quoted <= U128, 'Reference floor overflow');
  return quoteMinimum(quoted, slippageBps);
}

export function normalizeTrialPolicy(input, timestamp, validForSeconds = 1800) {
  assert(Number.isInteger(validForSeconds) && validForSeconds >= 60 && validForSeconds <= 3600, 'Window must be 60–3600 seconds');
  const p = {};
  for (const key of ['distribution', 'buybackV3', 'buybackTotal']) {
    p[key] = {amountIn: uint(input[key]?.amountIn, key + ' input', true), amountOut: uint(input[key]?.amountOut, key + ' output', true)};
  }
  for (const key of ['maxBnkrPerSwap', 'maxUsdcPerBuyback', 'bnkrBudget', 'usdcBudget']) p[key] = uint(input[key], key, key.startsWith('max'));
  assert(p.bnkrBudget > 0n || p.usdcBudget > 0n, 'Choose at least one funded trial mode');
  // Initial trial: cumulative allowance no greater than one trade cap per mode.
  // The guard can split that allowance into smaller trades; it has no call-count limit.
  assert(p.bnkrBudget === 0n || p.bnkrBudget === p.maxBnkrPerSwap, 'Trial BNKR budget must equal one trade cap');
  assert(p.usdcBudget === 0n || p.usdcBudget === p.maxUsdcPerBuyback, 'Trial USDC budget must equal one trade cap');
  assert.equal(p.distribution.amountIn, p.maxBnkrPerSwap, 'Distribution reference must quote the exact cap');
  assert.equal(p.buybackV3.amountIn, p.maxUsdcPerBuyback, 'V3 reference must quote the exact cap');
  assert.equal(p.buybackTotal.amountIn, p.maxUsdcPerBuyback, 'Total reference must quote the exact cap');
  assert(typeof input.sqrtPriceLimitX96 === 'string' && /^[0-9]+$/.test(input.sqrtPriceLimitX96), 'Explicit reviewed v4 price limit required');
  p.sqrtPriceLimitX96 = BigInt(input.sqrtPriceLimitX96);
  assert(p.sqrtPriceLimitX96 > MIN_SQRT && p.sqrtPriceLimitX96 < MAX_SQRT, 'Unbounded v4 price limit');
  p.slippageBps = input.slippageBps ?? 50;
  quoteMinimum(1n, p.slippageBps);
  p.validUntil = Number(timestamp) + validForSeconds;
  assert(Number.isSafeInteger(p.validUntil) && p.validUntil < 2 ** 48, 'Invalid expiry');
  return p;
}

export function assertTrialFunding(p, queue, minimumBatch, reserve) {
  if (p.bnkrBudget > 0n) {
    assert(queue > 0n && queue >= minimumBatch, 'BNKR queue below minimum batch');
    assert.equal(p.bnkrBudget, queue, 'Trial must cover the exact full BNKR queue');
  }
  if (p.usdcBudget > 0n) assert(p.usdcBudget <= reserve, 'Insufficient buyback reserve');
}

export async function readTrialReadiness(client, {config: C, artifacts: A, helpers: H}) {
  assert.equal(C.chainId, 8453, 'Base config required');
  assert.equal(await client.getChainId(), 8453, 'Base mainnet required');
  const head = await client.getBlock({blockTag:'latest'});
  const specs = [
    ['queue',C.distributor,'StakedDistributor','pendingSwapBnkr'], ['minimumBatch',C.distributor,'StakedDistributor','minBnkrBatch'],
    ['reserve',C.vault,'StakedVault','buybackReserve'], ['paused',H.guard,'StakedAutomationGuard','paused'],
    ['operator',H.guard,'StakedAutomationGuard','operator'], ['remainingBnkr',H.guard,'StakedAutomationGuard','remainingBnkr'],
    ['remainingUsdc',H.guard,'StakedAutomationGuard','remainingUsdc']
  ];
  const results = await client.multicall({contracts:specs.map(([,address,name,functionName]) => ({address,abi:A[name].abi,functionName})),blockNumber:head.number,allowFailure:false,batchSize:0});
  const state = Object.fromEntries(specs.map(([label],i) => [label,results[i]]));
  const distributionFunded = state.queue > 0n && state.queue >= state.minimumBatch;
  const buybackFunded = state.reserve > 0n;
  const blockers = [];
  if (!distributionFunded) blockers.push('BNKR queue below minimum batch');
  if (!buybackFunded) blockers.push('Buyback reserve is empty');
  if (getAddress(state.operator) !== getAddress(C.bankr)) blockers.push('Expected limited operator is not configured');
  if (!state.paused || state.remainingBnkr !== 0n || state.remainingUsdc !== 0n) blockers.push('First-window preparation requires paused trading and zero budgets');
  assert.equal((await client.getBlock({blockNumber:head.number})).hash, head.hash, 'Snapshot reorganized');
  return {chainId:8453,block:head.number,blockHash:head.hash,state,distributionFunded,buybackFunded,blockers,
    privateSubmissionVerified:false, signingPayloadPrepared:false, liveTransactionSent:false};
}

function assertFloor(p, name, quote) {
  const floor = policyFloor(p[name].amountIn, p[name], p.slippageBps);
  assert(floor <= quote, name + ': Safe floor exceeds current quote');
  assert(floor >= quoteMinimum(quote, 100), name + ': Safe floor is more than 1% below current quote');
  return floor;
}

export async function prepareTrialPolicy(client, {config: C, artifacts: A, helpers: H, policy: input, validForSeconds = 1800}) {
  assert.equal(C.chainId, 8453, 'Base config required');
  assert.equal(await client.getChainId(), 8453, 'Base mainnet required');
  const head = await client.getBlock({blockTag: 'latest'});
  const p = normalizeTrialPolicy(input, head.timestamp, validForSeconds);
  const read = (address, abi, functionName, args = []) => client.readContract({address, abi, functionName, args, blockNumber: head.number});
  const call = (name, address, fn, args = []) => read(address, A[name].abi, fn, args);
  const [queue, minimumBatch, reserve] = await client.multicall({contracts:[
    {address:C.distributor,abi:A.StakedDistributor.abi,functionName:'pendingSwapBnkr'},
    {address:C.distributor,abi:A.StakedDistributor.abi,functionName:'minBnkrBatch'},
    {address:C.vault,abi:A.StakedVault.abi,functionName:'buybackReserve'}],blockNumber:head.number,allowFailure:false,batchSize:0});
  assertTrialFunding(p, queue, minimumBatch, reserve);
  // Pin deployed code and administrative wiring before generating any authority-changing calldata.
  await Promise.all([['StakedAutomationGuard', H.guard], ['StakedBoundedBuybackExecutor', H.executor]].map(async ([name,address]) =>
    assertRuntime(A[name], await client.getBytecode({address, blockNumber:head.number}), name)));
  const checks = [
    ['StakedAutomationGuard', H.guard, {safe:C.safe, vault:C.vault, distributor:C.distributor, executor:H.executor, operator:C.bankr, paused:true, remainingBnkr:0n, remainingUsdc:0n}],
    ['StakedVault', C.vault, {owner:C.safe, pendingOwner:ZERO, keeper:H.guard, distributor:H.relay, buybackExecutor:H.executor}],
    ['StakedDistributor', C.distributor, {owner:C.safe, pendingOwner:ZERO, keeper:H.guard, vault:H.relay, liquidityWallet:C.safe, bnkrStakingWallet:C.safe,
      swapRouter:C.v3Router, bnkrWethFee:C.feeWethBnkr, wethUsdcFee:C.feeUsdcWeth}],
    ['StakedBoundedBuybackExecutor', H.executor, {safe:C.safe, guard:H.guard, vault:C.vault, usdc:C.usdc, weth:C.weth, bnkr:C.bnkr, staked:C.staked,
      router:C.v3Router, poolManager:C.poolManager, feeUsdcWeth:C.feeUsdcWeth, feeWethBnkr:C.feeWethBnkr}]
  ];
  const jobs = checks.flatMap(([name,address,values]) => Object.entries(values).map(([functionName,value]) => ({address,abi:A[name].abi,functionName,value,label:name+'.'+functionName})));
  const extra = [
    {address:H.executor,abi:A.StakedBoundedBuybackExecutor.abi,functionName:'poolKey'},
    {address:H.executor,abi:A.StakedBoundedBuybackExecutor.abi,functionName:'bnkrIsCurrency0'},
    ...['getOwners','getThreshold','nonce'].map(functionName => ({address:C.safe,abi:safeAbi,functionName})),
    {address:H.guard,abi:A.StakedAutomationGuard.abi,functionName:'nonce'}
  ];
  const values = await client.multicall({contracts:[...jobs,...extra],blockNumber:head.number,allowFailure:false,batchSize:0});
  jobs.forEach((job,i) => same(values[i],job.value,job.label));
  const [key,direction,owners,threshold,safeNonce,guardNonce] = values.slice(jobs.length);
  [C.poolKey.currency0,C.poolKey.currency1,C.poolKey.fee,C.poolKey.tickSpacing,C.poolKey.hooks].forEach((value,i) => same(key[i],value,'Pool key'));
  const zeroForOne = BigInt(C.bnkr) < BigInt(C.staked);
  same(direction, zeroForOne, 'Swap direction');
  assert.equal(owners.length, 3, 'Expected three Safe owners');
  assert.equal(threshold, 2n, 'Expected 2-of-3 Safe');
  assert(!owners.some(o => getAddress(o) === getAddress(C.bankr)), 'Bankr must not be a Safe owner');
  for (const address of [C.v3Quoter, ...(p.usdcBudget > 0n ? [C.v4Quoter,C.stateView] : [])]) {
    assert(address && getAddress(address), 'Explicit verified quoters required');
    assert((await client.getBytecode({address, blockNumber:head.number}))?.length > 2, 'Missing quoter/state-view code');
  }
  const quotes = {};
  if (p.bnkrBudget > 0n) {
    const path = await call('StakedDistributor', C.distributor, 'swapPath');
    const {result} = await client.simulateContract({address:C.v3Quoter, abi:v3Quoter, functionName:'quoteExactInput', args:[path,queue], blockNumber:head.number});
    quotes.distribution = {amountIn:queue, amountOut:result[0], floor:assertFloor(p,'distribution',result[0])};
  }
  if (p.usdcBudget > 0n) {
    const [sqrt] = await read(C.stateView, stateAbi, 'getSlot0', [C.poolId]);
    const limit = p.sqrtPriceLimitX96;
    assert(zeroForOne ? limit < sqrt : limit > sqrt, 'V4 price limit is on the wrong side of current price');
    assert(zeroForOne ? limit * limit * 10000n >= sqrt * sqrt * 9900n : limit * limit * 10000n <= sqrt * sqrt * 10100n,
      'V4 price boundary is more than 1% from current pool price');
    const path = encodePacked(['address','uint24','address','uint24','address'], [C.usdc,C.feeUsdcWeth,C.weth,C.feeWethBnkr,C.bnkr]);
    const first = await client.simulateContract({address:C.v3Quoter, abi:v3Quoter, functionName:'quoteExactInput', args:[path,p.usdcBudget], blockNumber:head.number});
    assert(first.result[0] > 0n && first.result[0] <= (1n << 127n) - 1n, 'V3 quote outside executor bounds');
    const second = await client.simulateContract({address:C.v4Quoter, abi:v4Quoter, functionName:'quoteExactInputSingle',
      args:[{poolKey:C.poolKey,zeroForOne,exactAmount:first.result[0],hookData:'0x'}], blockNumber:head.number});
    quotes.buybackV3 = {amountIn:p.usdcBudget, amountOut:first.result[0], floor:assertFloor(p,'buybackV3',first.result[0])};
    quotes.buybackTotal = {amountIn:p.usdcBudget, amountOut:second.result[0], floor:assertFloor(p,'buybackTotal',second.result[0])};
    quotes.sqrtPriceX96 = sqrt;
  }
  await client.simulateContract({address:H.guard, abi:A.StakedAutomationGuard.abi, functionName:'setPolicy', args:[p], account:C.safe, blockNumber:head.number});
  const latest = await client.getBlock({blockTag:'latest'});
  assert.equal(latest.number, head.number, 'Head changed during preparation; refresh references and retry');
  assert.equal(latest.hash, head.hash, 'Head reorganized; retry');
  const batch = {version:'1.0',chainId:'8453',createdAt:Number(head.timestamp)*1000,
    meta:{name:'First trading window — policy only, remains paused',description:'Cumulative budget equals one trade cap per enabled mode. No unpause or token movement. Regenerate before signing if references are stale.',txBuilderVersion:'1.18.0',createdFromSafeAddress:C.safe},
    transactions:[{to:H.guard,value:'0',data:encodeFunctionData({abi:A.StakedAutomationGuard.abi,functionName:'setPolicy',args:[p]})}]};
  batch.meta.checksum = safeChecksum(batch);
  return {batch, policy:p, quotes, block:head.number, blockHash:head.hash, safeNonce, guardNonce,
    simulation:'Exact setPolicy eth_call from Safe only; no signed Safe or end-to-end swap simulation.',
    limitations:['References remain manually Safe-reviewed; spot quotes are not a TWAP.', 'Quoter output does not prove a full fill under the v4 limit; execute a fork rehearsal before activation.',
      'No private submission or wallet signing integration is certified by this preparation.', 'This batch remains paused. Unpause is a separate Safe decision after route and execution checks.']};
}
