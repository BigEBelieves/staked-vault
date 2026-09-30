// Supplemental offline migration test. Real protocol bytecode; mock tokens,
// fee initializer, router and oracle pools. Not Base state or Safe signatures.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {VM} from '@ethereumjs/vm';
import {Block} from '@ethereumjs/block';
import {Common,Chain,Hardfork} from '@ethereumjs/common';
import {Address,Account,hexToBytes,bytesToHex} from '@ethereumjs/util';
import {encodeFunctionData,decodeFunctionResult,encodeDeployData,decodeErrorResult,getContractAddress} from 'viem';
const A=JSON.parse(readFileSync('build/all.json','utf8'));
const common=new Common({chain:Chain.Mainnet,hardfork:Hardfork.Shanghai});
const vm=await VM.create({common});let now=1800000000n;
const block=()=>Block.fromBlockData({header:{timestamp:now,number:100n,gasLimit:30000000n}},{common});
const address=n=>Address.fromString('0x'+n.toString(16).padStart(40,'0'));
const OWNER=address(161),ALICE=address(162),BOB=address(163),OPERATOR=address(164),OUTSIDER=address(165);
const ZERO='0x'+'0'.repeat(40),DEAD='0x000000000000000000000000000000000000dEaD',POOL='0x'+'21'.repeat(32);
const E18=10n**18n,DAY=86400n,SHARE=950000000000000000n;
for(const a of [OWNER,ALICE,BOB,OPERATOR,OUTSIDER])await vm.stateManager.putAccount(a,new Account(0n,10n**24n));
const s=c=>c.address.toString();const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const checks=[];function check(value,label){assert(value,label);checks.push(label);console.log('  ok '+label);}
async function deploy(name,args){
 const data=encodeDeployData({abi:A[name].abi,bytecode:A[name].bytecode,args});
 const r=await vm.evm.runCall({caller:OWNER,data:hexToBytes(data),gasLimit:16000000n,block:block()});
 assert(!r.execResult.exceptionError,'deploy '+name);return {name,address:r.createdAddress,abi:A[name].abi};
}
async function send(c,fn,args=[],from=OWNER){
 const data=encodeFunctionData({abi:c.abi,functionName:fn,args});
 const r=await vm.evm.runCall({caller:from,to:c.address,data:hexToBytes(data),gasLimit:10000000n,block:block()});
 if(r.execResult.exceptionError){
  let reason=r.execResult.exceptionError.error;
  try{const e=decodeErrorResult({abi:c.abi,data:bytesToHex(r.execResult.returnValue)});reason=e.args?.[0]??e.errorName;}catch{}
  throw new Error(c.name+'.'+fn+': '+reason);
 }
 if(!r.execResult.returnValue.length)return;
 return decodeFunctionResult({abi:c.abi,functionName:fn,data:bytesToHex(r.execResult.returnValue)});
}
const read=(c,fn,args=[])=>send(c,fn,args,OUTSIDER);
const balance=(t,a)=>read(t,'balanceOf',[a.toString()]);
const allowance=(t,a,b)=>read(t,'allowance',[a.toString(),b.toString()]);
const warp=seconds=>{now+=seconds;};
async function denied(c,fn,args,from,reason,label){await assert.rejects(send(c,fn,args,from),reason);check(true,label);}
const tokens={};for(const[name,decimals]of [['staked',18],['bnkr',18],['usdc',6],['weth',18]])tokens[name]=await deploy('MockERC20',[name,name,decimals]);
const {staked,bnkr,usdc,weth}=tokens;
const router=await deploy('MockRouter',[]),factory=await deploy('MockTwapFactory',[]);
for(const[tokenA,tokenB,fee]of [[bnkr,weth,10000],[weth,usdc,500]]){
 const pool=await deploy('MockTwapPool',[s(tokenA),s(tokenB),fee]);await send(factory,'setPool',[s(tokenA),s(tokenB),fee,s(pool)]);
}
const fees=await deploy('MockDopplerFees',[s(staked),s(bnkr)]);
const minimum=1000000n,cap=10000000n;
const limits={maxBnkrPerSwap:cap,maxBnkrPer24Hours:2n*cap,minLiquidityBnkrWeth:10n**24n,minLiquidityWethUsdc:10n**24n,minInterval:900,slippageBps:50,maxTickDeviation:100,maxInputReserveBps:20};
async function path(v3){
 const startedAt=now,firstNonce=(await vm.stateManager.getAccount(OWNER)).nonce;
 const futureRelay=getContractAddress({from:OWNER.toString(),nonce:firstNonce+2n});
 const futureKeeper=getContractAddress({from:OWNER.toString(),nonce:firstNonce+3n});
 const vault=await deploy(v3?'StakedVaultV3':'StakedVault',[s(staked),s(usdc),s(bnkr),OWNER.toString(),...(v3?[futureRelay]:[])]);
 const dist=await deploy(v3?'StakedDistributorV3':'StakedDistributor',[s(staked),s(bnkr),s(usdc),s(weth),s(router),v3?futureRelay:s(vault),OWNER.toString(),minimum,...(v3?[futureKeeper]:[])]);
 const relay=await deploy('StakedRewardRelay',[OWNER.toString(),s(vault),s(dist),s(usdc),s(bnkr)]);
 const keeper=await deploy(v3?'StakedTwapKeeperV3':'StakedTwapKeeper',[OWNER.toString(),{distributor:s(dist),relay:s(relay),bnkr:s(bnkr),weth:s(weth),usdc:s(usdc),router:s(router),factory:s(factory),...(v3?{predecessor:s(old.keeper)}:{})}]);
 const collector=await deploy('StakedFeeCollector',[OWNER.toString(),s(fees),POOL,s(staked),s(bnkr),s(dist)]);
 const wiring=[[vault,'setDistributor',[s(relay)]],[dist,'setVault',[s(relay)]],[dist,'setKeeper',[s(keeper)]]];
 if(v3){
  check(same(s(relay),futureRelay)&&same(s(keeper),futureKeeper),'future relay and keeper predictions match actual constructor deployments');
  check(same(await read(vault,'distributor'),s(relay))&&same(await read(dist,'vault'),s(relay))&&same(await read(dist,'keeper'),s(keeper)),'all initial connections are correct at construction');
  check(now===startedAt,'constructor wiring requires no time advance or configuration transaction');
  check(await read(vault,'CONFIGURATION_DELAY')===172800n&&await read(dist,'CONFIGURATION_DELAY')===172800n,'both cores enforce the fixed 48-hour delay from deployment');
  check(await read(keeper,'paused')&&same(await read(keeper,'operator'),ZERO),'new guarded conversion starts paused with no operator');
  for(const[c,fn,args]of wiring)await denied(c,fn,args,OWNER,/not scheduled/,'constructor wiring cannot be repeated through '+fn+' without scheduling');
 }else for(const[c,fn,args]of wiring)await send(c,fn,args);
 await send(keeper,'setLimits',[limits]);return {vault,dist,relay,keeper,collector};
}
const old=await path(false),next=await path(true);
await send(old.keeper,'setOperator',[OPERATOR.toString()]);await send(old.keeper,'setPaused',[false]);
await send(fees,'setShares',[s(old.collector),SHARE]);
// Two depositors, with real partial migration while one remains in the old vault.
const principalA=1000n*E18,principalB=3000n*E18,liquidA=123n*E18;
await send(staked,'mint',[ALICE.toString(),principalA+liquidA]);await send(staked,'mint',[BOB.toString(),principalB]);
for(const[user,principal]of [[ALICE,principalA],[BOB,principalB]]){
 await send(staked,'approve',[s(old.vault),principal],user);await send(old.vault,'stake',[principal],user);
}
const originalLock=await read(old.vault,'lockEnd',[ALICE.toString()]);
async function principalBacked(label){
 for(const p of [old,next])check(await balance(staked,p.vault.address)===await read(p.vault,'totalSupply'),label+': '+p.vault.name+' principal fully backed');
 check(await balance(staked,ALICE)+await balance(staked,BOB)+await balance(staked,old.vault.address)+await balance(staked,next.vault.address)===principalA+principalB+liquidA,label+': aggregate principal conserved');
}
await principalBacked('initial');
await send(fees,'setPayout',[0n,4n*minimum]);await send(old.collector,'collectAndDistribute',[],OUTSIDER);
const oldQueue=await read(old.dist,'pendingSwapBnkr');check(oldQueue===2n*minimum,'legacy queue is nonzero before migration');
// Start rewards late enough that the old stream is still active at stake maturity.
warp(3n*DAY);const funded={usdc:70000000n,bnkr:70n*E18};
for(const [name,amount]of Object.entries(funded)){
 await send(tokens[name],'mint',[OWNER.toString(),amount]);await send(tokens[name],'approve',[s(old.vault),amount]);await send(old.vault,'notifyRewardAmount',[s(tokens[name]),amount]);
}
warp(4n*DAY);
const earnedA={},earnedB={};
for(const name of ['usdc','bnkr']){
 earnedA[name]=await read(old.vault,'earned',[s(tokens[name]),ALICE.toString()]);earnedB[name]=await read(old.vault,'earned',[s(tokens[name]),BOB.toString()]);
 check(earnedA[name]>0n&&earnedB[name]>0n,'both users have nonzero old '+name+' claims');
 check((await read(old.vault,'rewardData',[s(tokens[name])]))[0]>now,'old '+name+' stream still active at opt-in');
}
await send(old.vault,'withdraw',[principalA],ALICE);
check(await balance(staked,ALICE)===liquidA+principalA,'mature legacy withdrawal returns full migrating principal');
for(const name of ['usdc','bnkr'])check(await read(old.vault,'earned',[s(tokens[name]),ALICE.toString()])===earnedA[name],'zero-principal account retains old '+name+' claim');
check(await read(old.vault,'balanceOf',[BOB.toString()])===principalB,'nonmigrating principal remains in old vault');
check(await read(old.vault,'lockEnd',[BOB.toString()])===originalLock,'other user lock unchanged');
await send(staked,'approve',[s(next.vault),principalA],ALICE);await send(next.vault,'stake',[principalA],ALICE);
check(await allowance(staked,ALICE,next.vault.address)===0n,'exact opt-in approval consumed');
check(await balance(staked,ALICE)===liquidA,'original personal liquid holdings preserved');
check(await read(next.vault,'lockEnd',[ALICE.toString()])===now+7n*DAY,'new stake explicitly starts a fresh seven-day lock');
await denied(next.vault,'exit',[],ALICE,/locked/,'locked V3 exit refuses implicit penalty');
await principalBacked('after opt-in');
// Mirrors the reviewed call order, but uses an EOA authority and separate calls.
// This deliberately does not claim to test Safe batching/atomicity or signatures.
await send(old.keeper,'setPaused',[true]);await send(old.keeper,'setOperator',[ZERO]);
await send(old.collector,'collectAndDistribute',[],OUTSIDER);await send(old.collector,'returnBeneficiaryToSafe');await send(fees,'updateBeneficiary',[POOL,s(next.collector)]);
await send(next.keeper,'setOperator',[OPERATOR.toString()]);await send(next.keeper,'setPaused',[false]);
check(await read(fees,'shares',[s(next.collector)])===SHARE&&await read(fees,'shares',[s(old.collector)])===0n,'fee rights move to the new collector in the local model');
check(await read(old.keeper,'paused')&&same(await read(old.keeper,'operator'),ZERO),'old trading disabled during cutover');
check(await read(old.dist,'pendingSwapBnkr')===oldQueue,'cutover preserves protected old queue');
for(const name of ['usdc','bnkr'])check(await read(old.vault,'earned',[s(tokens[name]),ALICE.toString()])===earnedA[name],'cutover leaves old '+name+' claim accessible');
await send(fees,'setPayout',[0n,4n*cap]);await send(next.collector,'collectAndDistribute',[],OUTSIDER);
const queue=await read(next.dist,'pendingSwapBnkr');check(queue===2n*cap,'new queue can exceed unchanged per-swap cap');
const input=7000000n,minOut=await read(next.keeper,'minimumUsdc',[input]),nonce=await read(next.keeper,'nonce');
await send(bnkr,'mint',[OUTSIDER.toString(),1n]);await send(bnkr,'transfer',[s(next.dist),1n],OUTSIDER);await send(next.dist,'distribute',[],OUTSIDER);
await send(next.keeper,'swapAndNotify',[input,minOut,Number(now+60n),nonce],OPERATOR);
const delivered=await balance(usdc,next.vault.address);
check(delivered>=minOut&&delivered>0n,'guarded mock conversion funds nonzero V3 USDC rewards');
check(await read(next.dist,'pendingSwapBnkr')===queue+1n-input,'late outsider dust cannot change prepared input');
check(await read(next.keeper,'spentLast24Hours')===input,'guarded budget accounts for actual selected input');
for(const[t,from,to]of [[bnkr,next.dist.address,router.address],[usdc,next.dist.address,next.relay.address],[usdc,next.relay.address,next.vault.address],[bnkr,next.collector.address,next.dist.address]])check(await allowance(t,from,to)===0n,'temporary route or collector allowance cleared');
await denied(next.dist,'swapBatchAndNotify',[input,1n],OPERATOR,/not keeper/,'operator cannot bypass new keeper floor');
warp(DAY);
check(await read(next.vault,'earned',[s(usdc),ALICE.toString()])>0n,'new vault accrues funded conversion rewards');
for(const name of ['usdc','bnkr']){
 check(await read(old.vault,'earned',[s(tokens[name]),ALICE.toString()])===earnedA[name],'departed user old '+name+' claim no longer grows');
 check(await read(old.vault,'earned',[s(tokens[name]),BOB.toString()])>earnedB[name],'remaining user old '+name+' rewards continue accruing');
}
const beforeRollback={oldQueue:await read(old.dist,'pendingSwapBnkr'),newQueue:await read(next.dist,'pendingSwapBnkr'),usdc:await balance(usdc,next.vault.address)};
await send(next.keeper,'setPaused',[true]);await send(next.keeper,'setOperator',[ZERO]);
await send(next.collector,'collectAndDistribute',[],OUTSIDER);await send(next.collector,'returnBeneficiaryToSafe');await send(fees,'updateBeneficiary',[POOL,s(old.collector)]);
check(await read(fees,'shares',[s(old.collector)])===SHARE&&await read(fees,'shares',[s(next.collector)])===0n,'rollback restores old collector rights');
for(const p of [old,next])check(await read(p.keeper,'paused')&&same(await read(p.keeper,'operator'),ZERO),'rollback keeps '+p.keeper.name+' disabled');
check(await read(old.dist,'pendingSwapBnkr')===beforeRollback.oldQueue&&await read(next.dist,'pendingSwapBnkr')===beforeRollback.newQueue,'rollback preserves both protected queues');
check(await balance(usdc,next.vault.address)===beforeRollback.usdc,'rollback preserves funded V3 reward backing');
await principalBacked('after rollback');
await send(old.vault,'getReward',[],ALICE);
for(const name of ['usdc','bnkr']){
 check(await balance(tokens[name],ALICE)===earnedA[name],'old '+name+' claim pays after opt-in, cutover and rollback');
 check(await read(old.vault,'earned',[s(tokens[name]),ALICE.toString()])===0n,'paid old '+name+' claim cannot be counted twice');
}
// The paused fee/conversion route must not prevent either vault's redemption.
warp(6n*DAY);
const dueB={};for(const name of ['usdc','bnkr'])dueB[name]=await read(old.vault,'earned',[s(tokens[name]),BOB.toString()]);
await send(old.vault,'exit',[],BOB);
check(await balance(staked,BOB)===principalB,'nonmigrating user can exit old vault after rollback');
for(const name of ['usdc','bnkr']){
 check(await balance(tokens[name],BOB)===dueB[name],'nonmigrating user receives old '+name+' claim');
 check(await balance(tokens[name],ALICE)+await balance(tokens[name],BOB)+await balance(tokens[name],old.vault.address)===funded[name],'old '+name+' funding is conserved across both claimants and dust');
 check(await balance(tokens[name],old.vault.address)<=4n,'old '+name+' remaining backing is rounding dust only');
}
const newDue=await read(next.vault,'earned',[s(usdc),ALICE.toString()]),beforeExit=await balance(usdc,ALICE);
check(newDue>0n,'mature V3 claim remains nonzero after rollback');
await send(next.vault,'exit',[],ALICE);
check(await balance(staked,ALICE)===principalA+liquidA,'V3 mature exit returns every migrated principal unit');
check(await balance(usdc,ALICE)===beforeExit+newDue,'V3 mature exit pays its separately funded USDC claim');
check(newDue+await balance(usdc,next.vault.address)===delivered,'V3 paid reward plus dust equals actual swap delivery');
check(await read(old.vault,'totalPenaltyBurned')===0n&&await read(next.vault,'totalPenaltyBurned')===0n&&await balance(staked,DEAD)===0n,'mature migration and exits burn no principal');
check(await read(old.vault,'buybackReserve')===0n&&await read(next.vault,'buybackReserve')===0n,'mature exits forfeit no USDC');
await principalBacked('after final exits');
check(await read(old.vault,'totalSupply')===0n&&await read(next.vault,'totalSupply')===0n,'both users fully redeemed from their chosen vaults');
// Constructor values do not exempt later changes, even if the vault is empty.
const change=encodeFunctionData({abi:next.dist.abi,functionName:'setKeeper',args:[OPERATOR.toString()]});
await denied(next.dist,'scheduleConfiguration',[change],OUTSIDER,/not owner/,'only the owner can schedule a later configuration change');
await send(next.dist,'scheduleConfiguration',[change]);
await denied(next.dist,'setKeeper',[OPERATOR.toString()],OWNER,/configuration delay/,'scheduled post-launch change still cannot execute immediately');
warp(2n*DAY-1n);
await denied(next.dist,'setKeeper',[OPERATOR.toString()],OWNER,/configuration delay/,'post-launch delay remains enforced one second before maturity');
warp(1n);await send(next.dist,'setKeeper',[OPERATOR.toString()]);
check(same(await read(next.dist,'keeper'),OPERATOR.toString()),'post-launch change executes after the full 48 hours');
await denied(next.dist,'setKeeper',[OPERATOR.toString()],OWNER,/not scheduled/,'executed change cannot reuse the notice period');
console.log(`${checks.length} local V3 migration checks passed; mocks used; Base fork and Safe atomicity are not tested here.`);
if(process.env.V3_LOCAL_MIGRATION_REPORT)writeFileSync(process.env.V3_LOCAL_MIGRATION_REPORT,JSON.stringify({mode:'OFFLINE EVM — mock external dependencies; not Base fork',checksPassed:checks.length,checks,limitations:['Fresh synthetic contracts and balances, not current Base state.','Mock token, fee initializer, router and oracle behavior; no market liquidity or real quote execution.','Owner modeled by local EOA; no Safe threshold, signatures, batch atomicity or bundler latency test.','Does not regenerate deployment nonce or unsigned plan.','No live transaction, personal transfer or automation change.'],observations:{migratingPrincipal:principalA,nonmigratingPrincipal:principalB,oldRewardFunding:funded,oldMigratingUserClaims:earnedA,oldRemainingUserClaims:dueB,newDeliveredUsdc:delivered,newPaidUsdc:newDue}},(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
