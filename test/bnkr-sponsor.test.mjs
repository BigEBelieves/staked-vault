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



const staked=await deploy('MockERC20',['STAKED','STAKED',18]);
const bnkr=await deploy('MockERC20',['BNKR','BNKR',18]);
const usdc=await deploy('MockERC20',['USDC','USDC',6]);
const bankr=await deploy('MockBankrStaking',[s(bnkr)]);
const vault=await deploy('StakedVaultV3',[s(staked),s(usdc),s(bnkr),OWNER.toString(),ZERO]);
const relay=await deploy('StakedRewardRelay',[OWNER.toString(),s(vault),s(bankr),s(usdc),s(bnkr)]);
const helper=await deploy('StakedBankrSponsor',[OWNER.toString(),s(bnkr),s(bankr),s(relay),BOB.toString()]);
const policy=encodeFunctionData({abi:helper.abi,functionName:'setPolicy',args:[KEEPER.toString(),100n*E18,200n*E18]});
await must(helper,'scheduleConfiguration',[policy]);
await expectRevert(send(helper,'setPolicy',[KEEPER.toString(),100n*E18,200n*E18]),'configuration delay','48 hour notice');
await expectRevert(send(helper,'setPaused',[false]),'Safe policy required','policy required');
await expectRevert(send(helper,'fund',[1n],BOB),'paused or exiting','no funding before activation');
const setRelay=encodeFunctionData({abi:vault.abi,functionName:'setDistributor',args:[s(relay)]});
await must(vault,'scheduleConfiguration',[setRelay]);warp(2*DAY);
await must(vault,'setDistributor',[s(relay)]);
await must(relay,'setYieldSource',[s(helper),true]);
await must(helper,'setPolicy',[KEEPER.toString(),100n*E18,200n*E18]);
await must(helper,'setPaused',[false]);
await must(staked,'mint',[ALICE.toString(),1000n*E18]);await must(staked,'approve',[s(vault),1000n*E18],ALICE);await must(vault,'stake',[1000n*E18],ALICE);
await must(bnkr,'mint',[BOB.toString(),200n*E18]);await must(bnkr,'approve',[s(helper),200n*E18],BOB);
await expectRevert(send(helper,'fund',[1n],OWNER),'not sponsor','Safe cannot register its own fee capital');
await expectRevert(send(helper,'fund',[0n],BOB),'funding limit','zero funding rejected');
await expectRevert(send(helper,'fund',[201n*E18],BOB),'funding limit','funded exposure capped');
await must(helper,'fund',[200n*E18],BOB);
assert(await allowance(bnkr,BOB,helper.address)===0n,'exact funding allowance consumed');
await must(bnkr,'mint',[s(helper),50n*E18]);
assert(await call(helper,'surplusBnkr')===50n*E18,'direct transfers are uncredited surplus');
assert(await call(helper,'principalOutstanding')===200n*E18,'sponsor debt excludes direct transfers');
async function conserved(label) {
  const idle=await call(helper,'fundedIdle'), active=await call(bankr,'stakeOf',[s(helper)]), cooling=await call(helper,'coolingPrincipal');
  assert(await call(helper,'principalOutstanding')===idle+active+cooling,label+' principal conservation');
  assert(await balance(bnkr,helper.address)===idle+await call(helper,'pendingYield')+await call(helper,'surplusBnkr'),label+' custody buckets');
}
await conserved('funded');
await expectRevert(send(helper,'stakePrincipal',[1n],RANDO),'not operator','outsider cannot stake');
await expectRevert(send(helper,'stakePrincipal',[101n*E18],KEEPER),'stake limit','deposit limit');
await must(bankr,'setMode',[true,false,false]);
await expectRevert(send(helper,'stakePrincipal',[100n*E18],KEEPER),'stake position mismatch','dishonest staking rolls back');
await conserved('reverted');
await must(bankr,'setMode',[false,false,true]);await must(helper,'stakePrincipal',[100n*E18],KEEPER);
assert(await allowance(bnkr,helper.address,bankr.address)===0n,'staking approval cleared');
await expectRevert(send(helper,'stakePrincipal',[1n],KEEPER),'stake interval','daily interval');
await must(bankr,'addReward',[s(helper),7n*E18]);await must(helper,'harvest',[],KEEPER);
assert(await call(helper,'pendingYield')===7n*E18,'only measured reward reserved');
await conserved('harvested');
await must(relay,'setYieldSource',[s(helper),false]);
await expectRevert(send(helper,'relayYield',[],KEEPER),'not yield source','relay rejection atomic');
assert(await call(helper,'pendingYield')===7n*E18,'failed relay preserves yield');
await must(relay,'setYieldSource',[s(helper),true]);await must(helper,'relayYield',[],KEEPER);
assert(await balance(bnkr,vault.address)===7n*E18,'earned BNKR delivered to real vault');
assert(await allowance(bnkr,helper.address,relay.address)===0n,'relay approval cleared');
warp(DAY);await must(helper,'stakePrincipal',[100n*E18],KEEPER);warp(DAY);
await expectRevert(send(helper,'stakePrincipal',[1n],KEEPER),'principal only','surplus cannot be staked');
await expectRevert(send(helper,'fund',[1n],BOB),'funding limit','active capital still counts at funding');
await expectRevert(send(helper,'beginExit',[],KEEPER),'not sponsor or Safe','operator cannot permanently exit');
await expectRevert(send(helper,'requestUnstake',[1n],KEEPER),'not sponsor or Safe','operator cannot unstake');
await expectRevert(send(helper,'withdrawPrincipal',[],RANDO),'not sponsor or Safe','outsider cannot withdraw');
await must(helper,'beginExit',[],BOB);
await expectRevert(send(helper,'setPaused',[false]),'Safe policy required','Safe cannot cancel sponsor exit');
await expectRevert(send(helper,'fund',[1n],BOB),'paused or exiting','exit blocks further funding');
await expectRevert(send(helper,'stakePrincipal',[1n],KEEPER),'paused or exiting','exit blocks further staking');
await must(helper,'requestUnstake',[80n*E18],BOB);
await expectRevert(send(helper,'withdrawPrincipal',[],BOB),'cooldown','sponsor obeys cooldown');
await conserved('cooling');
await must(bankr,'addReward',[s(helper),5n*E18]);await must(helper,'harvest',[],KEEPER);
await expectRevert(send(helper,'returnIdlePrincipal',[1n],BOB),'principal only','sponsor cannot recover yield or surplus');
await expectRevert(send(helper,'returnSurplus',[51n*E18]),'surplus only','Safe cannot sweep yield');
await expectRevert(send(helper,'rescueOtherToken',[s(bnkr),1n]),'BNKR protected','rescue cannot sweep principal');
await must(helper,'returnSurplus',[50n*E18]);
warp(2*DAY);await must(helper,'withdrawPrincipal',[],BOB);
assert(await balance(bnkr,BOB)===80n*E18,'partial recovered capital returned to sponsor');
assert(await call(helper,'pendingYield')===5n*E18,'withdrawal leaves earned rewards');
await conserved('partial exit');
await must(helper,'requestUnstake',[120n*E18],BOB);warp(2*DAY);
await must(helper,'withdrawPrincipal');
assert(await balance(bnkr,BOB)===200n*E18,'Safe assisted recovery also returns only to sponsor');
assert(await call(helper,'principalOutstanding')===0n,'no principal remains owed');
assert(await balance(bnkr,OWNER)===50n*E18,'Safe only received uncredited surplus');
await must(helper,'relayYield',[],KEEPER);await conserved('closed');
warp(7*DAY);await must(vault,'getReward',[],ALICE);
assert(await balance(bnkr,ALICE)>11n*E18,'STAKED staker claims earned yield after sponsor exit');
// Separate idle-capital exit requires no Bankr withdrawal or Safe signature.
const idle=await deploy('StakedBankrSponsor',[OWNER.toString(),s(bnkr),s(bankr),s(relay),BOB.toString()]);
await must(idle,'scheduleConfiguration',[policy]);warp(2*DAY);await must(idle,'setPolicy',[KEEPER.toString(),100n*E18,200n*E18]);await must(idle,'setPaused',[false]);
await must(bnkr,'approve',[s(idle),20n*E18],BOB);await must(idle,'fund',[20n*E18],BOB);
await must(idle,'beginExit',[],BOB);await must(idle,'returnIdlePrincipal',[20n*E18],BOB);
assert(await balance(bnkr,BOB)===200n*E18 && await call(idle,'principalOutstanding')===0n,'idle principal recovered independently');
// External code replacement fails closed rather than trusting a new staking implementation.
await vm.stateManager.putContractCode(bankr.address,hexToBytes('0x00'));
await expectRevert(send(helper,'harvest',[],KEEPER),'staking code changed','external code hash enforced');
console.log(`\n${pass} passed, ${fail} failed`);if(fail)process.exit(1);
