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

const staked = await deploy('MockERC20',['STAKED','STAKED',18]);
const bnkr = await deploy('MockERC20',['BNKR','BNKR',18]);
const usdc = await deploy('MockERC20',['USDC','USDC',6]);
const weth = await deploy('MockERC20',['WETH','WETH',18]);
const router = await deploy('MockRouter',[]);
const vault = await deploy('StakedVault',[s(staked),s(usdc),s(bnkr),OWNER.toString()]);
const dist = await deploy('StakedDistributor',[s(staked),s(bnkr),s(usdc),s(weth),s(router),s(vault),OWNER.toString(),100n]);
const relay = await deploy('StakedRewardRelay',[OWNER.toString(),s(vault),s(dist),s(usdc),s(bnkr)]);
const factory = await deploy('MockTwapFactory',[]);
const pool0 = await deploy('MockTwapPool',[s(bnkr),s(weth),10000]);
const pool1 = await deploy('MockTwapPool',[s(weth),s(usdc),500]);
await must(factory,'setPool',[s(bnkr),s(weth),10000,s(pool0)]);
await must(factory,'setPool',[s(weth),s(usdc),500,s(pool1)]);
const keeper = await deploy('StakedTwapKeeper',[OWNER.toString(),{distributor:s(dist),relay:s(relay),bnkr:s(bnkr),weth:s(weth),usdc:s(usdc),router:s(router),factory:s(factory)}]);
await must(vault,'setDistributor',[s(relay)]);
await must(dist,'setVault',[s(relay)]);
await must(dist,'setKeeper',[s(keeper)]);
const limits = {maxBnkrPerSwap:1000n,maxBnkrPer24Hours:2000n,minLiquidityBnkrWeth:10n**24n,minLiquidityWethUsdc:10n**24n,
 minInterval:900,slippageBps:50,maxTickDeviation:100,maxInputReserveBps:20};
const queue = async n => {await must(bnkr,'mint',[s(dist),2n*n]);await must(dist,'distribute',[],RANDO);};
const exec = async (extra={}) => send(keeper,'swapAndNotify',[extra.amount??await call(dist,'pendingSwapBnkr'),extra.minimum??await call(keeper,'minimumUsdc',[extra.amount??await call(dist,'pendingSwapBnkr')]),
 extra.deadline??Number(now+60n),extra.nonce??await call(keeper,'nonce')],extra.from??KEEPER);
const before = async () => [await call(keeper,'nonce'),await call(keeper,'spentLast24Hours'),await call(keeper,'lastExecution'),await call(dist,'pendingSwapBnkr')];
async function unchangedRevert(extra,reason,label) {const prev=await before();await expectRevert(exec(extra),reason,label);assert(JSON.stringify(await before(),(_,v)=>typeof v==='bigint'?v.toString():v)===JSON.stringify(prev,(_,v)=>typeof v==='bigint'?v.toString():v),label+' preserves nonce, budget and queue');}

console.log('[twap] authority and limits');
await expectRevert(send(keeper,'setOperator',[KEEPER.toString()],RANDO),'not Safe','outsider cannot appoint operator');
await expectRevert(send(keeper,'setLimits',[limits],KEEPER),'not Safe','operator cannot loosen limits');
for(const [delta,reason] of [[{slippageBps:101},'loose price'],[{maxTickDeviation:101},'loose price'],[{minInterval:899},'bad interval'],[{maxInputReserveBps:21},'loose size'],[{minLiquidityBnkrWeth:0n},'zero liquidity'],[{maxBnkrPer24Hours:999n},'bad caps']])
 await expectRevert(send(keeper,'setLimits',[{...limits,...delta}]),reason,'rejects unsafe limits');
await must(keeper,'setLimits',[limits]);await must(keeper,'setOperator',[KEEPER.toString()]);await queue(1000n);
await unchangedRevert({},'paused','starts paused');await must(keeper,'setPaused',[false]);
await expectRevert(send(keeper,'setLimits',[limits]),'pause first','limits require pause');
await expectRevert(send(keeper,'setPaused',[false],KEEPER),'not Safe','operator cannot unpause');
await expectRevert(send(dist,'swapAndNotify',[1n],KEEPER),'not keeper','Bankr cannot bypass TWAP keeper');
await unchangedRevert({from:RANDO},'not operator','outsider cannot swap');
await unchangedRevert({amount:999n},'batch changed','binds full queue');
await unchangedRevert({minimum:1n},'below TWAP floor','compromised operator cannot use trivial minimum');
await unchangedRevert({deadline:Number(now-1n)},'bad deadline','rejects expired transaction');
await unchangedRevert({deadline:Number(now+121n)},'bad deadline','rejects excessive lifetime');
await unchangedRevert({nonce:999n},'stale nonce','rejects stale nonce');
const expected=(1000n*990000n/1000000n)*999500n/1000000n;
assert(await call(keeper,'minimumUsdc',[1000n])===(expected*9950n+9999n)/10000n,'TWAP floor accounts for both pool fees and rounds up');

console.log('[twap] oracle failures and route drift');
for(const pool of [pool0,pool1]) {
 for(const [args,reason] of [[[1801,false,false],'stale pool'],[[0,true,false],'OLD'],[[0,false,true],'locked']]) {
  await must(pool,'setFailure',args);await unchangedRevert({minimum:1000n},reason,'oracle failure stops swaps');await must(pool,'setFailure',[0,false,false]);
 }
 for(const ticks of [[101,0,0],[0,101,0],[0,0,-101]]) {await must(pool,'setTicks',ticks);await unchangedRevert({minimum:1000n},'price deviation','spot or short/long divergence stops swap');}
 await must(pool,'setTicks',[0,0,0]);
 await must(pool,'setLiquidity',[1n,10n**28n]);await unchangedRevert({minimum:1000n},'thin liquidity','low current liquidity rejected');
 await must(pool,'setLiquidity',[10n**28n,10n**12n]);await unchangedRevert({minimum:1000n},'thin liquidity','low historical liquidity rejected');
 await must(pool,'setLiquidity',[10n**28n,10n**28n]);
}
await must(pool0,'setTicks',[0,0,100]);await must(pool0,'setRemainder',[-1n]);
await unchangedRevert({minimum:1000n},'price deviation','negative fractional mean rounds down and enforces the deviation boundary');
await must(pool0,'setTicks',[0,0,0]);await must(pool0,'setRemainder',[0n]);
for(const [fn,bad,good,reason] of [['setVault',RANDO.toString(),s(relay),'route changed'],['setSwapRouter',RANDO.toString(),s(router),'route changed'],['setLiquidityWallet',RANDO.toString(),OWNER.toString(),'payout changed'],['setBnkrStakingWallet',RANDO.toString(),OWNER.toString(),'payout changed']]) {
 await must(dist,fn,[bad]);await unchangedRevert({minimum:1000n},reason,'distributor configuration drift rejected');await must(dist,fn,[good]);
}
await must(dist,'setPoolFees',[3000,500]);await unchangedRevert({minimum:1000n},'fees changed','pool fee drift rejected');await must(dist,'setPoolFees',[10000,500]);
await must(router,'setRate',[1n,2n]);await unchangedRevert({},'Too little received','underdelivery rolls back spend');await must(router,'setRate',[1n,1n]);

console.log('[twap] rolling budget and successful fixed-destination distribution');
const oldVault=await balance(usdc,vault.address);const r=await exec();assert(r.ok,'TWAP guarded swap succeeds');
assert(await balance(usdc,vault.address)===oldVault+1000n,'USDC reaches original vault');
assert(await call(dist,'pendingSwapBnkr')===0n,'queue drained');
assert(await call(keeper,'spentLast24Hours')===1000n,'rolling spend recorded');
assert(await balance(bnkr,KEEPER)===0n&&await balance(usdc,KEEPER)===0n,'Bankr receives no tokens');
for(const [token,a,b] of [[bnkr,dist.address,router.address],[usdc,dist.address,relay.address],[usdc,relay.address,vault.address]])assert(await allowance(token,a,b)===0n,'transient protocol allowance cleared');
await queue(1000n);await unchangedRevert({},'cooldown','cooldown enforced');warp(900);assert((await exec()).ok,'second permitted swap succeeds');
await queue(1000n);warp(900);await unchangedRevert({},'spending cap','cumulative daily cap enforced');
await must(keeper,'setPaused',[true],KEEPER);await must(keeper,'setLimits',[limits]);await must(keeper,'setOperator',[KEEPER.toString()]);await must(keeper,'setPaused',[false]);
assert(await call(keeper,'spentLast24Hours')===2000n,'pause and reconfiguration do not reset spending history');
await unchangedRevert({},'spending cap','cannot reset budget by changing config');
warp(86400-1800-1);await unchangedRevert({},'spending cap','rolling budget does not reset at calendar boundary');warp(1);
assert(await call(keeper,'spentLast24Hours')===1000n,'only first trade expires at exact 24h');assert((await exec()).ok,'budget renews automatically without Safe renewal');
await queue(1001n);warp(900);await unchangedRevert({minimum:1001n},'spending cap','per trade cap remains enforced');
await must(keeper,'setPaused',[true]);await must(keeper,'setLimits',[{...limits,maxBnkrPerSwap:2000n,maxBnkrPer24Hours:1000000n,minLiquidityBnkrWeth:1n,minLiquidityWethUsdc:1n}]);await must(keeper,'setPaused',[false]);
await must(pool0,'setLiquidity',[1000n,1000n]);await unchangedRevert({minimum:1001n},'input too large','virtual reserve size cap enforced');await must(pool0,'setLiquidity',[10n**28n,10n**28n]);
await must(pool1,'setLiquidity',[1000n,1000n]);await unchangedRevert({minimum:1001n},'input too large','second leg reserve cap enforced');await must(pool1,'setLiquidity',[10n**28n,10n**28n]);
await must(pool0,'setWrap',[true]);await must(pool1,'setWrap',[true]);
assert((await exec()).ok,'oracle cumulative wraparound supported');
await must(pool0,'setWrap',[false]);await must(pool1,'setWrap',[false]);
for(let i=0;i<98;i++){warp(900);await queue(1000n);const rr=await exec();if(!rr.ok)throw new Error('ring test '+i+': '+rr.reason);}
assert(await call(keeper,'spentLast24Hours')===96000n,'rolling ring retains all 96 trades in the last 24 hours');
await must(keeper,'setPaused',[true]);await must(keeper,'setOperator',[ZERO]);await expectRevert(send(keeper,'setPaused',[false]),'not configured','operator can be permanently disabled');
assert((await call(dist,'owner')).toLowerCase()===OWNER.toString().toLowerCase(),'Safe retains ownership');

console.log('[twap] ported math differential vectors');
const math=await deploy('TwapMathHarness',[]);
const max=(1n<<256n)-1n;
for(let i=1n;i<=80n;i++) {
 const a=(max/(i+1n))^(i*123456789n),b=(1n<<180n)+i*999n,d=(1n<<200n)+i*1337n;
 assert(await call(math,'mulDiv',[a,b,d])===a*b/d,'512-bit mulDiv matches BigInt division');
 assert(await call(math,'mulDivUp',[a,b,d])===(a*b+d-1n)/d,'512-bit mulDiv rounding matches BigInt');
}
await expectRevert(send(math,'mulDiv',[1n,1n,0n]),'revert','division by zero rejected');
await expectRevert(send(math,'mulDiv',[max,max,1n]),'revert','overflow rejected');
for(const [tick,value] of [[-887272,4295128739n],[0,1n<<96n],[887272,1461446703485210103287273052203988822378723970342n]])assert(await call(math,'sqrt',[tick])===value,'TickMath boundary reference vector');
await expectRevert(send(math,'sqrt',[887273]),'T','invalid tick rejected');
console.log(`${pass} passed, ${fail} failed`);if(fail)process.exitCode=1;
