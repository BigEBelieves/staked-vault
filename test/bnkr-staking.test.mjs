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
const helper=await deploy('StakedBankrStakingAdapter',[OWNER.toString(),s(bnkr),s(bankr),s(relay)]);
const policy=encodeFunctionData({abi:helper.abi,functionName:'setPolicy',args:[KEEPER.toString(),100n*E18,200n*E18]});
await must(helper,'scheduleConfiguration',[policy]);
await expectRevert(send(helper,'setPolicy',[KEEPER.toString(),100n*E18,200n*E18]),'configuration delay','policy notice is mandatory');
await expectRevert(send(helper,'setPaused',[false]),'Safe policy required','cannot activate without policy');
const setRelay=encodeFunctionData({abi:vault.abi,functionName:'setDistributor',args:[s(relay)]});
await must(vault,'scheduleConfiguration',[setRelay]);warp(2*DAY);
await must(vault,'setDistributor',[s(relay)]);
await must(relay,'setYieldSource',[s(helper),true]);
await must(helper,'setPolicy',[KEEPER.toString(),100n*E18,200n*E18]);
await must(helper,'setPaused',[false]);
await must(staked,'mint',[ALICE.toString(),1000n*E18]);await must(staked,'approve',[s(vault),1000n*E18],ALICE);await must(vault,'stake',[1000n*E18],ALICE);
await must(bnkr,'mint',[s(helper),250n*E18]);
await expectRevert(send(helper,'stakeFees',[1n],RANDO),'not operator','outsider cannot stake');
await expectRevert(send(helper,'stakeFees',[101n*E18],KEEPER),'stake limit','daily stake cap');
await must(bankr,'setMode',[true,false,false]);
await expectRevert(send(helper,'stakeFees',[100n*E18],KEEPER),'stake position mismatch','dishonest position reverts the transfer');
assert(await balance(bnkr,helper.address)===250n*E18,'reverted stake preserves principal');
await must(bankr,'setMode',[false,false,true]);
await must(helper,'stakeFees',[100n*E18],KEEPER);
assert(await call(bankr,'stakeOf',[s(helper)])===100n*E18,'principal staked, callback blocked');
assert(await allowance(bnkr,helper.address,bankr.address)===0n,'staking allowance cleared');
await expectRevert(send(helper,'stakeFees',[1n],KEEPER),'stake interval','no repeated deposits within 24h');
await must(bankr,'addReward',[s(helper),7n*E18]);await must(helper,'harvest',[],KEEPER);
assert(await call(helper,'pendingYield')===7n*E18,'actual reward delta measured despite dishonest return');
assert(await call(helper,'idlePrincipal')===150n*E18,'yield excluded from idle principal');
await expectRevert(send(helper,'harvest',[],KEEPER),'harvest interval','harvest cadence enforced');
await must(relay,'setYieldSource',[s(helper),false]);
await expectRevert(send(helper,'relayYield',[],KEEPER),'not yield source','disabled relay rejects without losing yield');
assert(await call(helper,'pendingYield')===7n*E18,'failed relay retains reserved rewards');
await must(relay,'setYieldSource',[s(helper),true]);await must(helper,'relayYield',[],KEEPER);
assert(await balance(bnkr,vault.address)===7n*E18,'BNKR yield reached actual V3 vault through relay');
assert(await allowance(bnkr,helper.address,relay.address)===0n,'relay allowance cleared');
warp(DAY);await must(helper,'stakeFees',[100n*E18],KEEPER);
warp(DAY);await expectRevert(send(helper,'stakeFees',[1n],KEEPER),'exposure limit','aggregate principal cap');
await expectRevert(send(helper,'requestUnstake',[1n],KEEPER),'not Safe','keeper cannot withdraw principal');
await must(helper,'setPaused',[true],KEEPER);
await expectRevert(send(helper,'setPaused',[false],KEEPER),'Safe policy required','keeper cannot restart');
await must(helper,'requestUnstake',[50n*E18]);
await expectRevert(send(helper,'withdrawPrincipal'),'cooldown','Bankr cooldown enforced');
await must(helper,'setPaused',[false]);
await expectRevert(send(helper,'stakeFees',[1n],KEEPER),'exposure limit','cooling principal still counts toward cap');
await must(helper,'setPaused',[true]);
await must(bankr,'addReward',[s(helper),5n*E18]);await must(helper,'harvest',[],KEEPER);
await expectRevert(send(helper,'returnIdlePrincipal',[51n*E18]),'principal only','Safe cannot sweep pending yield as principal');
await expectRevert(send(helper,'rescueOtherToken',[s(bnkr),1n]),'BNKR protected','rescue cannot bypass reserved yield');
await must(helper,'returnIdlePrincipal',[50n*E18]);
warp(2*DAY);const old=await balance(bnkr,OWNER);await must(helper,'withdrawPrincipal');
assert(await balance(bnkr,OWNER)===old+50n*E18,'mature principal goes only to Safe, measured not return value');
assert(await call(helper,'coolingPrincipal')===0n,'cooling bookkeeping cleared');
assert(await call(helper,'pendingYield')===5n*E18,'withdrawal never consumes reserved yield');
await must(helper,'relayYield',[],KEEPER);
assert(await call(helper,'totalYieldRelayed')===12n*E18,'harvest and relay remain usable during emergency pause');
warp(7*DAY);assert(await call(vault,'earned',[s(bnkr),ALICE.toString()])>11n*E18,'STAKED staker accrues Bankr yield');
await must(vault,'getReward',[],ALICE);assert(await balance(bnkr,ALICE)>11n*E18,'STAKED staker can claim BNKR');
await expectRevert(send(helper,'advanceStaking',[181],KEEPER),'advance bound','bounded catch-up call');
console.log(`\n${pass} passed, ${fail} failed`);if(fail)process.exit(1);
