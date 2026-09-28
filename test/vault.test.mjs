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
const blk = () => Block.fromBlockData({ header: { timestamp: now, gasLimit: 30_000_000n } }, { common });
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

// ---------------- setup ----------------
const staked = await deploy('MockERC20', ['STAKED', 'STAKED', 18]);
const usdc = await deploy('MockERC20', ['USDC', 'USDC', 6]);
const bnkr = await deploy('MockERC20', ['BNKR', 'BNKR', 18]);
const weth = await deploy('MockERC20', ['WETH', 'WETH', 18]);
const router = await deploy('MockRouter', []);
const vault = await deploy('StakedVault', [staked.address.toString(), usdc.address.toString(), bnkr.address.toString(), OWNER.toString()]);
const MIN_BATCH = 10n ** 21n; // 1000 BNKR
const dist = await deploy('StakedDistributor', [staked.address.toString(), bnkr.address.toString(), usdc.address.toString(), weth.address.toString(), router.address.toString(), vault.address.toString(), OWNER.toString(), MIN_BATCH]);
const exec = await deploy('MockBuybackExecutor', [usdc.address.toString(), staked.address.toString()]);
await send(vault, 'setDistributor', [dist.address.toString()]);
await send(vault, 'setKeeper', [KEEPER.toString()]);
await send(vault, 'setBuybackExecutor', [exec.address.toString()]);
await send(dist, 'setKeeper', [KEEPER.toString()]);
const E18 = 10n ** 18n;
const bal = (t, who) => call(t, 'balanceOf', [who.toString ? who.toString() : who]);
async function fund(t, who, amt) { await send(t, 'mint', [who.toString(), amt]); await send(t, 'approve', [vault.address.toString(), 2n ** 255n], who); }

// ---------------- 1. precision ----------------
console.log('\n[1] usdc precision with 100B-supply staking token');
{
  const big = 50_000_000_000n * E18; // 50B STAKED
  await fund(staked, ALICE, big);
  let r = await send(vault, 'stake', [big], ALICE); assert(r.ok, 'alice stakes 50B STAKED');
  await send(usdc, 'mint', [OWNER.toString(), 100_000_000n]);
  await send(usdc, 'approve', [vault.address.toString(), 2n ** 255n]);
  r = await send(vault, 'notifyRewardAmount', [usdc.address.toString(), 100_000_000n]); assert(r.ok, 'owner notifies 100 USDC');
  warp(DAY);
  const e1 = await call(vault, 'earned', [usdc.address.toString(), ALICE.toString()]);
  approx(e1, 100_000_000n / 7n, 5n, 'after 1 day alice earned ~1/7 of 100 USDC (old design: 0)');
  warp(6 * DAY);
  const e7 = await call(vault, 'earned', [usdc.address.toString(), ALICE.toString()]);
  approx(e7, 100_000_000n, 1n, 'after 7 days alice earned ~100 USDC');
  const rate = await call(vault, 'getRewardForDuration', [usdc.address.toString()]);
  approx(rate, 100_000_000n, 1n, 'getRewardForDuration ~100 USDC');
}

// ---------------- 2. lock + claim ----------------
console.log('\n[2] lock, claim, top-up reset');
{
  // alice's lock ended exactly now (7d). claim should work
  let r = await send(vault, 'getReward', [], ALICE); assert(r.ok, 'claim after 7d succeeds');
  const ub = await bal(usdc, ALICE); approx(ub, 100_000_000n, 1n, 'alice received ~100 USDC');
  // new stream + top-up resets timer
  await send(usdc, 'mint', [OWNER.toString(), 70_000_000n]);
  await send(vault, 'notifyRewardAmount', [usdc.address.toString(), 70_000_000n]);
  await fund(staked, ALICE, 1000n * E18);
  r = await send(vault, 'stake', [1000n * E18], ALICE); assert(r.ok, 'alice tops up');
  assert(await call(vault, 'isLocked', [ALICE.toString()]) === true, 'top-up relocks the whole balance');
  warp(3 * DAY);
  await expectRevert(send(vault, 'getReward', [], ALICE), 'locked', 'claim at day 3 after top-up');
  const tu = await call(vault, 'timeUntilUnlock', [ALICE.toString()]);
  assert(tu === BigInt(4 * DAY), 'timeUntilUnlock = 4 days');
}

// ---------------- 3. early exit ----------------
console.log('\n[3] early exit: 20% burn, rewards forfeited -> buyback reserve');
{
  const before = await bal(staked, ALICE);
  const deadBefore = await bal(staked, DEAD);
  const earnedU = await call(vault, 'earned', [usdc.address.toString(), ALICE.toString()]);
  approx(earnedU, 30_000_000n, 5n, 'alice has ~30 USDC accrued at day 3');
  const pv = await call(vault, 'previewWithdraw', [ALICE.toString(), 1000n * E18]);
  assert(pv[1] === 200n * E18 && pv[0] === 800n * E18, 'previewWithdraw shows 200 penalty / 800 returned');
  const r = await send(vault, 'withdraw', [1000n * E18], ALICE); assert(r.ok, 'early withdraw 1000');
  assert((await bal(staked, ALICE)) - before === 800n * E18, 'alice got 800 back');
  assert((await bal(staked, DEAD)) - deadBefore === 200n * E18, '200 STAKED burned to 0xdead');
  const reserve = await call(vault, 'buybackReserve');
  assert(reserve === earnedU, `forfeited USDC (${reserve}) moved to buybackReserve`);
  assert((await call(vault, 'earned', [usdc.address.toString(), ALICE.toString()])) === 0n, 'alice accrued reset to 0');
  assert(await call(vault, 'isLocked', [ALICE.toString()]) === true, 'remaining balance still locked (no reset on withdraw)');
  // rest of stream continues to alice's remaining 50B
  warp(4 * DAY);
  const e = await call(vault, 'earned', [usdc.address.toString(), ALICE.toString()]);
  approx(e, 40_000_000n, 5n, 'remaining ~40 USDC accrues to the remaining stake');
  const r2 = await send(vault, 'exit', [], ALICE); assert(r2.ok, 'mature exit() works');
  assert((await call(vault, 'totalSupply')) === 0n, 'vault empty');
}

// ---------------- 4. buyback ----------------
console.log('\n[4] buyback: keeper-gated, slippage enforced, burns');
{
  const reserve = await call(vault, 'buybackReserve');
  await expectRevert(send(vault, 'executeBuyback', [reserve, 1n], RANDO), 'not keeper', 'rando cannot execute buyback');
  await expectRevert(send(vault, 'executeBuyback', [reserve + 1n, 1n], KEEPER), 'bad amount', 'cannot spend more than reserve');
  await send(exec, 'setUnderDeliver', [true]);
  await expectRevert(send(vault, 'executeBuyback', [reserve, reserve * 10n ** 15n], KEEPER), 'slippage', 'under-delivery reverts');
  await send(exec, 'setUnderDeliver', [false]);
  const deadBefore = await bal(staked, DEAD);
  const r = await send(vault, 'executeBuyback', [reserve, reserve * 10n ** 15n], KEEPER); assert(r.ok, 'keeper buyback succeeds');
  assert((await bal(staked, DEAD)) - deadBefore === reserve * 10n ** 15n, 'bought STAKED burned to 0xdead');
  assert((await call(vault, 'buybackReserve')) === 0n, 'reserve drained');
  { const d = await bal(usdc, vault.address); assert(d < 10n, 'vault holds only rounding dust (' + d + ' wei USDC) after claims/buyback'); }
}

// ---------------- 5. undistributed + pro-rata ----------------
console.log('\n[5] rewards while empty are recoverable; pro-rata split');
{
  await send(usdc, 'mint', [OWNER.toString(), 70_000_000n]);
  let r = await send(vault, 'notifyRewardAmount', [usdc.address.toString(), 70_000_000n]); assert(r.ok, 'notify 70 USDC into empty vault');
  warp(DAY); // 10 USDC streams to nobody
  await fund(staked, ALICE, 1000n * E18); await fund(staked, BOB, 3000n * E18);
  await send(vault, 'stake', [1000n * E18], ALICE); await send(vault, 'stake', [3000n * E18], BOB);
  const und = (await call(vault, 'rewardData', [usdc.address.toString()]))[4];
  approx(und, 10_000_000n, 5n, 'undistributed tracked ~10 USDC');
  r = await send(vault, 'restreamUndistributed', [usdc.address.toString()], RANDO); assert(r.ok, 'anyone can restream undistributed');
  warp(7 * DAY);
  const ea = await call(vault, 'earned', [usdc.address.toString(), ALICE.toString()]);
  const eb = await call(vault, 'earned', [usdc.address.toString(), BOB.toString()]);
  approx(ea + eb, 70_000_000n, 2n, 'full 70 USDC distributed after restream');
  approx(eb, ea * 3n, 2n, 'bob (3000) earns 3x alice (1000)');
  await send(vault, 'exit', [], ALICE); await send(vault, 'exit', [], BOB);
}

// ---------------- 6. distributor ----------------
console.log('\n[6] distributor split, threshold, keeper swap, notify');
{
  await send(staked, 'mint', [dist.address.toString(), 10_000n * E18]);
  await send(bnkr, 'mint', [dist.address.toString(), 1500n * E18]);
  const deadBefore = await bal(staked, DEAD);
  let r = await send(dist, 'distribute', [], RANDO); assert(r.ok, 'distribute() is permissionless');
  assert((await bal(staked, DEAD)) - deadBefore === 5000n * E18, '50% STAKED burned');
  assert((await bal(staked, OWNER)) === 5000n * E18, '50% STAKED to liquidity wallet');
  assert((await bal(bnkr, OWNER)) === 750n * E18, '50% BNKR to staking wallet');
  assert((await call(dist, 'pendingSwapBnkr')) === 750n * E18, '50% BNKR queued for swap');
  assert(await call(dist, 'canSwap') === false, 'below 1000 BNKR threshold -> cannot swap');
  await expectRevert(send(dist, 'swapAndNotify', [1n], KEEPER), 'below batch', 'swap below threshold reverts');
  // second distribute must NOT re-split the pending half
  r = await send(dist, 'distribute', [], RANDO);
  assert((await bal(bnkr, OWNER)) === 750n * E18 && (await call(dist, 'pendingSwapBnkr')) === 750n * E18, 'second distribute() does not re-split pending BNKR');
  await send(bnkr, 'mint', [dist.address.toString(), 500n * E18]);
  await send(dist, 'distribute', [], RANDO);
  assert((await call(dist, 'pendingSwapBnkr')) === 1000n * E18, 'pending reaches 1000 BNKR');
  assert(await call(dist, 'canSwap') === true, 'canSwap true at threshold');
  await expectRevert(send(dist, 'rescueToken', [bnkr.address.toString(), 1n, OWNER.toString()]), 'pending swap protected', 'owner cannot rescue pending-swap BNKR');
  await expectRevert(send(dist, 'rescueToken', [staked.address.toString(), 1n, OWNER.toString()]), 'STAKED protected', 'owner cannot rescue STAKED');
  await expectRevert(send(dist, 'swapAndNotify', [1n], RANDO), 'not keeper', 'rando cannot swap');
  await expectRevert(send(dist, 'swapAndNotify', [0n], KEEPER), 'minOut=0', 'minOut must be > 0');
  // router pays 0.0001 USDC-wei per BNKR-wei => 1000e18 * 1 / 1e13 = 1e8 = 100 USDC
  await send(router, 'setRate', [1n, 10n ** 13n]);
  await expectRevert(send(dist, 'swapAndNotify', [200_000_000n], KEEPER), 'Too little', 'swap reverts when quote < minOut (sandwich guard)');
  assert((await call(dist, 'pendingSwapBnkr')) === 1000n * E18, 'pending untouched after failed swap');
  await fund(staked, ALICE, 1000n * E18); await send(vault, 'stake', [1000n * E18], ALICE);
  r = await send(dist, 'swapAndNotify', [99_000_000n], KEEPER); assert(r.ok, 'keeper swap succeeds with sane minOut');
  assert(r.out === 100_000_000n, 'swap returned 100 USDC');
  const path = await call(dist, 'swapPath');
  assert(path.toLowerCase() === (bnkr.address.toString() + '002710' + weth.address.toString().slice(2) + '0001f4' + usdc.address.toString().slice(2)).toLowerCase(), 'path = BNKR -1%-> WETH -0.05%-> USDC');
  { const d = await bal(usdc, vault.address); assert(d >= 100_000_000n && d < 100_000_010n, 'USDC landed in vault (' + d + ')'); }
  warp(7 * DAY);
  approx(await call(vault, 'earned', [usdc.address.toString(), ALICE.toString()]), 100_000_000n, 1n, 'alice earns the streamed 100 USDC');
  await send(vault, 'exit', [], ALICE);
}

// ---------------- 7. bnkr stream + forfeited bnkr re-streamed ----------------
console.log('\n[7] BNKR reward leg + forfeited BNKR restream');
{
  await send(bnkr, 'mint', [OWNER.toString(), 700n * E18]);
  await send(bnkr, 'approve', [vault.address.toString(), 2n ** 255n]);
  await fund(staked, ALICE, 1000n * E18); await send(vault, 'stake', [1000n * E18], ALICE);
  let r = await send(vault, 'notifyRewardAmount', [bnkr.address.toString(), 700n * E18]); assert(r.ok, 'owner streams 700 BNKR (path a yield relay)');
  await expectRevert(send(vault, 'notifyRewardAmount', [bnkr.address.toString(), 1n], RANDO), 'not authorized', 'rando cannot notify');
  warp(DAY);
  await send(vault, 'withdraw', [1000n * E18], ALICE);
  const und = (await call(vault, 'rewardData', [bnkr.address.toString()]))[4];
  approx(und, 100n * E18, 5n, 'forfeited ~100 BNKR sits in undistributed for restream');
}

// ---------------- 8. admin ----------------
console.log('\n[8] admin');
{
  await expectRevert(send(vault, 'setKeeper', [RANDO.toString()], RANDO), 'not owner', 'rando cannot set keeper');
  await expectRevert(send(vault, 'recoverERC20', [usdc.address.toString(), 1n, OWNER.toString()]), 'protected', 'owner cannot recover reward tokens');
  await expectRevert(send(vault, 'recoverERC20', [staked.address.toString(), 1n, OWNER.toString()]), 'protected', 'owner cannot recover STAKED');
  await expectRevert(send(vault, 'setRewardsDuration', [3 * DAY]), 'period active', 'cannot change duration mid-stream');
  let r = await send(vault, 'transferOwnership', [BOB.toString()]); assert(r.ok, 'transferOwnership starts');
  assert((await call(vault, 'owner')) === OWNER.toString().toLowerCase() || (await call(vault, 'owner')).toLowerCase() === OWNER.toString().toLowerCase(), 'owner unchanged until accept');
  r = await send(vault, 'acceptOwnership', [], BOB); assert(r.ok, 'bob accepts');
  assert((await call(vault, 'owner')).toLowerCase() === BOB.toString().toLowerCase(), 'ownership moved (2-step)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
