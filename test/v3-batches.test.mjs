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


async function fixture(mockPrevious=false) {
 const staked = await deploy('MockERC20',['STAKED','STAKED',18]);
 const bnkr = await deploy('MockERC20',['BNKR','BNKR',18]);
 const usdc = await deploy('MockERC20',['USDC','USDC',6]);
 const weth = await deploy('MockERC20',['WETH','WETH',18]);
 const router = await deploy('MockRouter',[]);
 const vault = await deploy('StakedVaultV3',[s(staked),s(usdc),s(bnkr),OWNER.toString(),ZERO]);
 const dist = await deploy('StakedDistributorV3',[s(staked),s(bnkr),s(usdc),s(weth),s(router),s(vault),OWNER.toString(),100n,OWNER.toString()]);
 const relay = await deploy('StakedRewardRelay',[OWNER.toString(),s(vault),s(dist),s(usdc),s(bnkr)]);
 const factory=await deploy('MockTwapFactory',[]);
 const pool0=await deploy('MockTwapPool',[s(bnkr),s(weth),10000]);
 const pool1=await deploy('MockTwapPool',[s(weth),s(usdc),500]);
 await must(factory,'setPool',[s(bnkr),s(weth),10000,s(pool0)]);await must(factory,'setPool',[s(weth),s(usdc),500,s(pool1)]);
 const config={distributor:s(dist),relay:s(relay),bnkr:s(bnkr),weth:s(weth),usdc:s(usdc),router:s(router),factory:s(factory)};
 const predecessor=mockPrevious?await deploy('MockTwapPredecessor',[OWNER.toString(),s(bnkr)]):await deploy('StakedTwapKeeper',[OWNER.toString(),config]);
 config.predecessor=s(predecessor);
 const keeper=await deploy('StakedTwapKeeperV3',[OWNER.toString(),config]);
 const settings=[[vault,'setDistributor',[s(relay)]],[dist,'setVault',[s(relay)]],[dist,'setKeeper',[s(keeper)]]];
 for(const[c,fn,args]of settings)await must(c,'scheduleConfiguration',[encodeFunctionData({abi:c.abi,functionName:fn,args})]);
 warp(172800);for(const[c,fn,args]of settings)await must(c,fn,args);
 const limits={maxBnkrPerSwap:1000n,maxBnkrPer24Hours:2000n,minLiquidityBnkrWeth:10n**24n,minLiquidityWethUsdc:10n**24n,minInterval:900,slippageBps:50,maxTickDeviation:100,maxInputReserveBps:20};
 await must(keeper,'setLimits',[limits]);await must(keeper,'setOperator',[KEEPER.toString()]);await must(keeper,'setPaused',[false]);
 const queue=async n=>{await must(bnkr,'mint',[s(dist),n*2n]);await must(dist,'distribute',[],RANDO);};
 const args=async amount=>[amount,await call(keeper,'minimumUsdc',[amount]),Number(now+60n),await call(keeper,'nonce')];
 return {staked,bnkr,usdc,weth,router,vault,dist,relay,factory,pool0,pool1,keeper,predecessor,config,limits,queue,args};
}
console.log('[v3 batch] donations cannot resize a prepared bounded swap');
{
 const f=await fixture();await f.queue(1000n);const args=await f.args(1000n);
 await must(f.bnkr,'mint',[RANDO.toString(),1n]);await must(f.bnkr,'transfer',[s(f.dist),1n],RANDO);await must(f.dist,'distribute',[],RANDO);
 assert(await call(f.dist,'pendingSwapBnkr')===1001n,'outsider donation changes full queue');
 await must(f.keeper,'swapAndNotify',args,KEEPER);
 assert(await call(f.dist,'pendingSwapBnkr')===1n,'prepared input succeeds and donated dust remains queued');
 assert(await call(f.keeper,'spentLast24Hours')===1000n && await call(f.dist,'totalBnkrSwapped')===1000n,'keeper and distributor account for exact input');
 assert(await balance(f.usdc,f.vault.address)===1000n,'bounded swap delivers through relay into V3 vault');
 for(const[t,a,b]of [[f.bnkr,f.dist.address,f.router.address],[f.usdc,f.dist.address,f.relay.address],[f.usdc,f.relay.address,f.vault.address]])assert(await allowance(t,a,b)===0n,'partial swap clears transient allowance');
 await expectRevert(send(f.keeper,'swapAndNotify',args,KEEPER),'stale nonce','prepared batch cannot replay');
}
console.log('[v3 batch] queue above cap drains in bounded batches without raised limits');
{
 const f=await fixture();await f.queue(2500n);
 await must(f.keeper,'swapAndNotify',await f.args(1000n),KEEPER);assert(await call(f.dist,'pendingSwapBnkr')===1500n,'large queue partially drains at unchanged cap');
 await expectRevert(send(f.keeper,'swapAndNotify',await f.args(1000n),KEEPER),'cooldown','partial batches retain interval');
 warp(900);await must(f.keeper,'swapAndNotify',await f.args(1000n),KEEPER);assert(await call(f.dist,'pendingSwapBnkr')===500n,'second batch retains remainder');
 warp(900);await expectRevert(send(f.keeper,'swapAndNotify',await f.args(500n),KEEPER),'spending cap','partial batches cannot exceed rolling daily cap');
 await must(f.keeper,'setPaused',[true],KEEPER);await must(f.keeper,'setLimits',[f.limits]);await must(f.keeper,'setOperator',[KEEPER.toString()]);await must(f.keeper,'setPaused',[false]);
 assert(await call(f.keeper,'spentLast24Hours')===2000n,'reconfiguration does not reset rolling spend');
 warp(86400);await must(f.keeper,'swapAndNotify',await f.args(500n),KEEPER);assert(await call(f.dist,'pendingSwapBnkr')===0n,'remaining eligible batch drains after rolling budget renews');
}
console.log('[v3 batch] unchanged security checks bind each actual batch');
{
 const f=await fixture();await f.queue(1000n);
 const cases=[{amount:1001n,reason:'insufficient queue'},{amount:99n,reason:'below batch threshold'},{amount:0n,minimum:1n,reason:'insufficient queue'},
  {amount:500n,minimum:1n,reason:'below TWAP floor'},{amount:500n,deadline:Number(now-1n),reason:'bad deadline'},
  {amount:500n,deadline:Number(now+121n),reason:'bad deadline'},{amount:500n,from:RANDO,reason:'not operator'}];
 for(const c of cases){
  const nonce=await call(f.keeper,'nonce');const args=[c.amount,c.minimum??await call(f.keeper,'minimumUsdc',[c.amount]),c.deadline??Number(now+60n),nonce];
  await expectRevert(send(f.keeper,'swapAndNotify',args,c.from??KEEPER),c.reason,'invalid bounded batch rejected');
  assert(await call(f.dist,'pendingSwapBnkr')===1000n && await call(f.keeper,'nonce')===nonce && await call(f.keeper,'spentLast24Hours')===0n,'rejected batch preserves queue, nonce and budget');
 }
 await expectRevert(send(f.dist,'swapBatchAndNotify',[500n,1n],KEEPER),'not keeper','operator cannot bypass guard through new distributor entry');
 await expectRevert(send(f.dist,'swapAndNotify',[1n],KEEPER),'not keeper','operator cannot bypass guard through legacy convenience entry');
 await must(f.router,'setRate',[1n,2n]);await expectRevert(send(f.keeper,'swapAndNotify',await f.args(500n),KEEPER),'Too little received','bad output rolls back');
 assert(await call(f.dist,'pendingSwapBnkr')===1000n && await call(f.keeper,'spentLast24Hours')===0n,'failed partial swap preserves all queue and budget');await must(f.router,'setRate',[1n,1n]);
 await must(f.pool0,'setFailure',[1801,false,false]);await expectRevert(send(f.keeper,'swapAndNotify',[500n,500n,Number(now+60n),await call(f.keeper,'nonce')],KEEPER),'stale pool','partial swaps retain oracle freshness');await must(f.pool0,'setFailure',[0,false,false]);
 await must(f.keeper,'setPaused',[true],KEEPER);await expectRevert(send(f.keeper,'swapAndNotify',await f.args(500n),KEEPER),'paused','operator pause stops bounded batch');
 await expectRevert(send(f.keeper,'setPaused',[false],KEEPER),'not Safe','operator cannot unpause');
 const old=await deploy('StakedDistributor',[s(f.staked),s(f.bnkr),s(f.usdc),s(f.weth),s(f.router),s(f.vault),OWNER.toString(),100n]);
 let rejected=false;try{await deploy('StakedTwapKeeperV3',[OWNER.toString(),{...f.config,distributor:s(old)}]);}catch{rejected=true;}assert(rejected,'V3 keeper rejects incompatible legacy distributor at construction');
}
console.log('[v3 migration budget] predecessor spend and interval survive cutover');
{
 const f=await fixture(true);await f.queue(4000n);
 await must(f.predecessor,'record',[Number(now),1500n]);
 assert(await call(f.keeper,'spentLast24Hours')===1500n,'new keeper inherits unexpired legacy spend');
 await expectRevert(send(f.keeper,'swapAndNotify',await f.args(1000n),KEEPER),'spending cap','legacy spend prevents a second full daily budget');
 await expectRevert(send(f.keeper,'swapAndNotify',await f.args(500n),KEEPER),'cooldown','legacy last execution preserves the cross-cutover interval');
 warp(899);await expectRevert(send(f.keeper,'swapAndNotify',await f.args(500n),KEEPER),'cooldown','inherited interval remains enforced one second before maturity');
 warp(1);await must(f.keeper,'swapAndNotify',await f.args(500n),KEEPER);
 assert(await call(f.keeper,'spentLast24Hours')===2000n,'remaining allowance is usable without a blanket migration wait');
 await must(f.keeper,'setPaused',[true]);await must(f.keeper,'setLimits',[f.limits]);await must(f.keeper,'setOperator',[KEEPER.toString()]);await must(f.keeper,'setPaused',[false]);
 assert(await call(f.keeper,'spentLast24Hours')===2000n,'reconfiguration retains aggregate old and new spend');
 warp(85499);await expectRevert(send(f.keeper,'swapAndNotify',await f.args(100n),KEEPER),'spending cap','legacy trade still counts one second before 24 hours');
 warp(1);assert(await call(f.keeper,'spentLast24Hours')===500n,'legacy spend expires at its own exact 24-hour boundary');
 await must(f.predecessor,'setActive',[true]);
 await expectRevert(send(f.keeper,'swapAndNotify',await f.args(1000n),KEEPER),'predecessor active','re-enabling legacy trading stops the new trading path');
 await must(f.keeper,'setPaused',[true]);await expectRevert(send(f.keeper,'setPaused',[false]),'predecessor active','new path cannot unpause while predecessor is active');
 await must(f.predecessor,'setActive',[false]);await must(f.keeper,'setPaused',[false]);
 await must(f.keeper,'swapAndNotify',await f.args(1000n),KEEPER);
 assert(await call(f.keeper,'spentLast24Hours')===1500n,'new history survives expiration of legacy history');
 warp(900);assert(await call(f.keeper,'spentLast24Hours')===1000n,'each keeper history expires independently');
 let rejected=false;try{await deploy('StakedTwapKeeperV3',[OWNER.toString(),{...f.config,predecessor:ZERO}]);}catch{rejected=true;}assert(rejected,'missing predecessor cannot bypass aggregate accounting');
 const wrong=await deploy('MockTwapPredecessor',[RANDO.toString(),s(f.bnkr)]);
 rejected=false;try{await deploy('StakedTwapKeeperV3',[OWNER.toString(),{...f.config,predecessor:s(wrong)}]);}catch{rejected=true;}assert(rejected,'predecessor must bind the same Safe and BNKR');
}
console.log('[v3 withdrawal] normal calls cannot implicitly forfeit rewards');
{
 const f=await fixture();const amount=1000n*E18;
 await must(f.staked,'mint',[ALICE.toString(),amount]);await must(f.staked,'approve',[s(f.vault),amount],ALICE);await must(f.vault,'stake',[amount],ALICE);
 for(const token of [f.usdc,f.bnkr]){await must(token,'mint',[OWNER.toString(),7000000n]);await must(token,'approve',[s(f.vault),7000000n]);await must(f.vault,'notifyRewardAmount',[s(token),7000000n]);}warp(DAY);
 const earnedU=await call(f.vault,'earned',[s(f.usdc),ALICE.toString()]),earnedB=await call(f.vault,'earned',[s(f.bnkr),ALICE.toString()]);
 await expectRevert(send(f.vault,'withdraw',[100n*E18],ALICE),'locked','ordinary partial withdrawal reverts during lock');
 await expectRevert(send(f.vault,'exit',[],ALICE),'locked','exit reverts during lock');
 assert(await call(f.vault,'earned',[s(f.usdc),ALICE.toString()])===earnedU,'rejected ordinary call preserves rewards');
 await must(f.vault,'earlyWithdraw',[100n*E18],ALICE);
 assert(await balance(f.staked,ALICE)===80n*E18 && await balance(f.staked,DEAD)===20n*E18,'explicit partial early withdrawal burns only twenty percent of withdrawn amount');
 assert(await call(f.vault,'balanceOf',[ALICE.toString()])===900n*E18,'remaining principal stays staked');
 assert(await call(f.vault,'buybackReserve')===earnedU && (await call(f.vault,'rewardData',[s(f.bnkr)]))[4]===earnedB,'all accrued rewards are explicitly forfeited as documented');
 warp(6*DAY);await expectRevert(send(f.vault,'earlyWithdraw',[100n*E18],ALICE),'not locked','early entry cannot be used at maturity');
 await must(f.vault,'withdraw',[900n*E18],ALICE);assert(await balance(f.staked,ALICE)===980n*E18,'mature withdrawal returns all remaining principal');
}
console.log(`${pass} V3 batch/withdrawal checks passed, ${fail} failed`);process.exit(fail?1:0);
