import { VM } from '@ethereumjs/vm';
import { Block } from '@ethereumjs/block';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { encodeFunctionData, decodeFunctionResult, encodeDeployData, decodeErrorResult, parseAbi } from 'viem';
import { readFileSync } from 'fs';

const A = JSON.parse(readFileSync('build/all.json', 'utf8'));
const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });
const vm = await VM.create({ common });
let now = 1_800_000_000n;
let blockNumber = 100n;
const blk = () => Block.fromBlockData({ header: { number: blockNumber, timestamp: now, gasLimit: 30_000_000n } }, { common });
const addr = (n) => Address.fromString('0x' + n.toString(16).padStart(40, '0'));
const OWNER = addr(0xA1), ALICE = addr(0xA2), BOB = addr(0xA3), KEEPER = addr(0xA4), RANDO = addr(0xA5);
const DEAD = '0x000000000000000000000000000000000000dEaD';
for (const a of [OWNER, ALICE, BOB, KEEPER, RANDO]) await vm.stateManager.putAccount(a, new Account(0n, 10n ** 24n));

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('  ok   ' + msg); } else { fail++; console.log('  FAIL ' + msg); } }
function approx(a, b, tolBps = 1n, msg) { const d = a > b ? a - b : b - a; assert(d * 10000n <= b * tolBps + 1n, `${msg} (${a} ~ ${b})`); }

async function deploy(name, args, from = OWNER) {
  const data = encodeDeployData({ abi: A[name].abi, bytecode: A[name].bytecode, args });
  const r = await vm.evm.runCall({ caller: from, data: hexToBytes(data), gasLimit: 10_000_000n, block: blk() });
  if (r.execResult.exceptionError) throw new Error('deploy failed ' + name + ' ' + r.execResult.exceptionError.error);
  return { name, address: r.createdAddress, abi: A[name].abi };
}
async function send(c, fn, args = [], from = OWNER) {
  const data = encodeFunctionData({ abi: c.abi, functionName: fn, args });
  const r = await vm.evm.runCall({ caller: from, to: c.address, data: hexToBytes(data), gasLimit: 5_000_000n, block: blk() });
  if (r.execResult.exceptionError) {
    let reason = r.execResult.exceptionError.error;
    try { const d = decodeErrorResult({ abi: c.abi, data: bytesToHex(r.execResult.returnValue) }); reason = d.args?.[0] ?? d.errorName; } catch {}
    return { ok: false, reason, gas: r.execResult.executionGasUsed };
  }
  let out;
  try { out = decodeFunctionResult({ abi: c.abi, functionName: fn, data: bytesToHex(r.execResult.returnValue) }); } catch {}
  return { ok: true, out, gas: r.execResult.executionGasUsed };
}
const call = async (c, fn, args = []) => (await send(c, fn, args, RANDO)).out;
async function expectRevert(p, needle, msg) { const r = await p; assert(!r.ok && String(r.reason).includes(needle), `${msg} -> reverted "${r.reason}"`); }
const warp = (s) => { now += BigInt(s); };
const DAY = 86400;


const s = c => c.address.toString();
const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const ZERO = '0x' + '0'.repeat(40);
const POOL = '0x' + '12'.repeat(32);
const limit = 2n ** 96n;
async function must(c, fn, args = [], from = OWNER) {
  const r = await send(c, fn, args, from);
  if (!r.ok) throw new Error(`${c.name}.${fn}: ${r.reason}`);
  return r.out;
}
const balance = (t, a) => call(t, 'balanceOf', [a.toString()]);
const allowance = (t, a, b) => call(t, 'allowance', [a.toString(), b.toString()]);
const staked = await deploy('MockERC20', ['STAKED', 'STAKED', 18]);
const bnkr = await deploy('MockERC20', ['BNKR', 'BNKR', 18]);
const usdc = await deploy('MockERC20', ['USDC', 'USDC', 6]);
const weth = await deploy('MockERC20', ['WETH', 'WETH', 18]);
const router = await deploy('MockRouter', []);
const manager = await deploy('MockBoundedPoolManager', []);
const vault = await deploy('StakedVault', [s(staked), s(usdc), s(bnkr), OWNER.toString()]);
const dist = await deploy('StakedDistributor', [s(staked), s(bnkr), s(usdc), s(weth), s(router), s(vault), OWNER.toString(), 1n]);
const relay = await deploy('StakedRewardRelay', [OWNER.toString(), s(vault), s(dist), s(usdc), s(bnkr)]);
const guard = await deploy('StakedAutomationGuard', [OWNER.toString(), s(vault), s(dist)]);
const config = { vault: s(vault), guard: s(guard), usdc: s(usdc), weth: s(weth), bnkr: s(bnkr), staked: s(staked),
  router: s(router), poolManager: s(manager), feeUsdcWeth: 500, feeWethBnkr: 10000,
  v4Fee: 8388608, tickSpacing: 200, hooks: ZERO };
const executor = await deploy('StakedBoundedBuybackExecutor', [OWNER.toString(), config]);
const fees = await deploy('MockDopplerFees', [s(bnkr), s(staked)]);
const collector = await deploy('StakedFeeCollector', [OWNER.toString(), s(fees), POOL, s(staked), s(bnkr), s(dist)]);
await must(vault, 'setDistributor', [s(relay)]);
await must(dist, 'setVault', [s(relay)]);
await must(vault, 'setKeeper', [s(guard)]);
await must(dist, 'setKeeper', [s(guard)]);
await must(vault, 'setBuybackExecutor', [s(executor)]);
await must(guard, 'setExecutor', [s(executor)]);
await must(guard, 'setOperator', [KEEPER.toString()]);
const policy = () => ({
  distribution: { amountIn: 1000n * E18, amountOut: 1000n * E6 },
  buybackV3: { amountIn: E6, amountOut: E18 },
  buybackTotal: { amountIn: E6, amountOut: 2n * E18 },
  maxBnkrPerSwap: 1000n * E18, maxUsdcPerBuyback: E6,
  bnkrBudget: 1000n * E18, usdcBudget: 2n * E6,
  sqrtPriceLimitX96: limit, validUntil: Number(now + 3600n), slippageBps: 100
});
const auth = async () => [blockNumber, Number(now + 30n), await call(guard, 'nonce')];
const buy = async (from = KEEPER, extra = {}) => send(guard, 'executeBuyback',
  [extra.amount ?? E6, extra.minBnkr ?? E18 * 99n / 100n, extra.minStaked ?? 2n * E18 * 99n / 100n,
   extra.block ?? blockNumber, extra.deadline ?? Number(now + 30n), extra.nonce ?? await call(guard, 'nonce')], from);

console.log('\n[automation] fixed-destination fees and reward relay');
await must(fees, 'setShares', [s(collector), 950000000000000000n]);
await must(fees, 'setPayout', [2000n * E18, 100n * E18]);
await must(collector, 'collectAndDistribute', [], RANDO);
assert(await balance(staked, OWNER) === 50n * E18, 'STAKED liquidity share reaches Safe');
assert(await balance(bnkr, OWNER) === 1000n * E18, 'BNKR staking share reaches Safe');
assert(await call(dist, 'pendingSwapBnkr') === 1000n * E18, 'beneficiary balance, not collect return value, is distributed');
assert(await balance(bnkr, KEEPER) === 0n && await balance(staked, KEEPER) === 0n, 'keeper never receives fee custody');
assert(await allowance(bnkr, collector.address, dist.address) === 0n && await allowance(staked, collector.address, dist.address) === 0n, 'collector allowances cleared');
await expectRevert(send(collector, 'returnBeneficiaryToSafe', [], KEEPER), 'not Safe', 'keeper cannot redirect fee rights');
await expectRevert(send(collector, 'sweepToSafe', [s(bnkr)], KEEPER), 'not Safe', 'keeper cannot sweep fees');
await expectRevert(send(relay, 'setYieldSource', [KEEPER.toString(), true], KEEPER), 'not Safe', 'keeper cannot authorize itself');
await expectRevert(send(relay, 'relayBnkr', [E18], KEEPER), 'not yield source', 'BNKR relay rejects unauthorized donor');
await expectRevert(send(relay, 'notifyRewardAmount', [s(usdc), E6], KEEPER), 'not distributor USDC', 'keeper cannot impersonate distributor');
await expectRevert(send(relay, 'notifyRewardAmount', [s(bnkr), E18], dist.address), 'not distributor USDC', 'distributor cannot relay arbitrary reward token');
await must(relay, 'setYieldSource', [KEEPER.toString(), true]);
await must(bnkr, 'mint', [KEEPER.toString(), 10n * E18]);
await must(bnkr, 'approve', [s(relay), 10n * E18], KEEPER);
await must(relay, 'relayBnkr', [10n * E18], KEEPER);
assert(await balance(bnkr, vault.address) === 10n * E18, 'authorized donor funds BNKR rewards without vault ownership');
assert(await allowance(bnkr, relay.address, vault.address) === 0n, 'reward relay clears vault allowance');
await must(relay, 'setYieldSource', [KEEPER.toString(), false]);
await expectRevert(send(relay, 'relayBnkr', [1n], KEEPER), 'not yield source', 'revocation takes effect');

console.log('\n[automation] Safe policy and distributor compatibility');
await expectRevert(send(guard, 'setPolicy', [policy()], KEEPER), 'not Safe', 'keeper cannot change Safe reference');
await expectRevert(send(guard, 'setPolicy', [{...policy(), slippageBps: 101}]), 'slippage > 1%', 'rejects >1% policy slippage');
await expectRevert(send(guard, 'setPolicy', [{...policy(), validUntil: Number(now + 3601n)}]), 'bad expiry', 'rejects long-lived reference');
await expectRevert(send(guard, 'setPolicy', [{...policy(), sqrtPriceLimitX96: 4295128740n}]), 'unbounded v4 price', 'rejects unrestricted v4 limit');
await expectRevert(send(guard, 'setPolicy', [{...policy(), distribution: {amountIn: 0n, amountOut: 1n}}]), 'bad distribution', 'rejects zero reference input');
await must(guard, 'setPolicy', [policy()]);
assert(await call(guard, 'distributionFloor', [1n]) === 1n, 'rounding cannot produce zero floor');
await expectRevert(buy(), 'paused', 'starts paused');
await must(guard, 'setPaused', [false]);
await expectRevert(send(dist, 'swapAndNotify', [1n], KEEPER), 'not keeper', 'Bankr cannot call old distributor directly');
await expectRevert(send(vault, 'executeBuyback', [E6, 1n], KEEPER), 'not keeper', 'Bankr cannot call old vault directly');
await expectRevert(send(guard, 'swapAndNotify', [1000n * E18, 1n, ...await auth()], KEEPER), 'below Safe floor', 'compromised keeper cannot use minOut=1');
await expectRevert(send(guard, 'swapAndNotify', [999n * E18, 990n * E6, ...await auth()], KEEPER), 'batch changed', 'pending amount must match quote');
await expectRevert(send(guard, 'swapAndNotify', [1000n * E18, 990n * E6, ...await auth()], RANDO), 'not operator', 'random caller cannot execute swaps');
await must(router, 'setRate', [1n, 10n ** 12n]);
const oldNonce = await call(guard, 'nonce');
const beforeUsdc = await balance(usdc, vault.address);
await must(guard, 'swapAndNotify', [1000n * E18, 990n * E6, ...await auth()], KEEPER);
assert(await balance(usdc, vault.address) - beforeUsdc === 1000n * E6, 'old distributor streams through adapter into original vault');
assert(await call(dist, 'pendingSwapBnkr') === 0n, 'existing queue drained exactly once');
assert(await call(guard, 'remainingBnkr') === 0n, 'cumulative BNKR budget consumed');
assert(await allowance(usdc, dist.address, relay.address) === 0n && await allowance(usdc, relay.address, vault.address) === 0n, 'distribution allowances reset');
await expectRevert(send(guard, 'swapAndNotify', [1000n * E18, 990n * E6, blockNumber, Number(now + 30n), oldNonce], KEEPER), 'stale nonce', 'replayed execution rejected');

console.log('\n[automation] real vault reserve and bounded buyback');
await must(staked, 'mint', [ALICE.toString(), 1000n * E18]);
await must(staked, 'approve', [s(vault), 1000n * E18], ALICE);
await must(vault, 'stake', [1000n * E18], ALICE);
warp(DAY);
await must(vault, 'withdraw', [1000n * E18], ALICE);
assert(await call(vault, 'buybackReserve') > 2n * E6, 'real early exit builds reserve');
await must(guard, 'setPolicy', [policy()]);
await must(router, 'setRate', [10n ** 12n, 1n]);
await expectRevert(buy(KEEPER, {minBnkr: 1n}), 'below Safe floor', 'first v3 leg cannot have trivial floor');
await expectRevert(buy(KEEPER, {minStaked: 1n}), 'below Safe floor', 'final floor independent of keeper');
await expectRevert(buy(KEEPER, {amount: E6 + 1n}), 'USDC cap', 'per-trade cap enforced');
await expectRevert(buy(KEEPER, {block: blockNumber - 3n}), 'stale quote', 'stale block rejected');
await expectRevert(buy(KEEPER, {block: blockNumber + 1n}), 'stale quote', 'future block rejected');
await expectRevert(buy(KEEPER, {deadline: Number(now - 1n)}), 'bad deadline', 'expired deadline rejected');
await expectRevert(buy(KEEPER, {deadline: Number(now + 61n)}), 'bad deadline', 'long deadline rejected');
await expectRevert(send(executor, 'buyback', [E6, E18], KEEPER), 'not vault', 'executor rejects direct keeper');
await expectRevert(send(vault, 'executeBuyback', [E6, E18]), 'no active buyback', 'even owner cannot bypass executor guard context');
await expectRevert(send(executor, 'unlockCallback', ['0x'], manager.address), 'unexpected callback', 'pool manager cannot invoke out-of-context callback');
await expectRevert(send(executor, 'unlockCallback', ['0x'], KEEPER), 'unexpected callback', 'spoofed callback rejected');
const reserve = await call(vault, 'buybackReserve');
const budget = await call(guard, 'remainingUsdc');
const nonce = await call(guard, 'nonce');
for (const [mode, reason] of [[1, 'partial v4 fill'], [2, 'missing callback'], [3, 'unexpected callback'], [4, 'final slippage'], [5, 'final slippage']]) {
  await must(manager, 'setMode', [BigInt(mode)]);
  await expectRevert(buy(), reason, `manager mode ${mode} reverts whole buyback`);
  assert(await call(vault, 'buybackReserve') === reserve && await call(guard, 'remainingUsdc') === budget && await call(guard, 'nonce') === nonce,
    `mode ${mode} preserves reserve, budget, nonce`);
}
await must(manager, 'setMode', [0n]);
await must(router, 'setRate', [1n, 1n]);
await expectRevert(buy(), 'Too little received', 'v3 router enforces nonzero intermediate floor');
await must(router, 'setRate', [10n ** 12n, 1n]);
const deadBefore = await balance(staked, DEAD);
assert((await buy()).ok, 'bounded buyback succeeds through original vault');
assert(await balance(staked, DEAD) - deadBefore === 2n * E18, 'delivered tokens burned by original vault');
assert(await call(manager, 'lastLimit') === limit, 'Safe price limit forwarded to v4');
assert(await call(manager, 'lastDirection') === await call(executor, 'bnkrIsCurrency0'), 'v4 direction matches token sorting');
assert(await balance(bnkr, executor.address) === 0n && await balance(usdc, executor.address) === 0n, 'no stranded intermediate assets');
assert(await allowance(usdc, executor.address, router.address) === 0n && await allowance(usdc, vault.address, executor.address) === 0n, 'buyback approvals cleared');
assert((await buy()).ok, 'second call spends remaining allowed budget');
await expectRevert(buy(), 'USDC cap', 'repeated small swaps cannot exceed total budget');
await must(guard, 'setPolicy', [policy()]);
warp(3601);
await expectRevert(buy(), 'expired', 'stale Safe reference fails closed');
await must(guard, 'setPolicy', [policy()]);
await must(guard, 'setPaused', [true], KEEPER);
await expectRevert(send(guard, 'setPaused', [false], KEEPER), 'not Safe', 'operator may pause but cannot unpause');
await expectRevert(buy(), 'paused', 'pause takes effect');
await must(guard, 'setPaused', [false]);
await must(guard, 'setOperator', [ZERO]);
await expectRevert(buy(), 'not operator', 'operator revocation takes effect');
await must(collector, 'returnBeneficiaryToSafe');
assert(await call(fees, 'shares', [s(collector)]) === 0n && await call(fees, 'shares', [OWNER.toString()]) === 950000000000000000n, 'Safe can recover beneficiary rights');
assert((await call(vault, 'owner')).toLowerCase() === OWNER.toString(), 'vault ownership never delegated to automation');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
