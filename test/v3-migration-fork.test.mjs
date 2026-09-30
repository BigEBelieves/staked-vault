// All mutations are confined to a freshly started, loopback-only Anvil fork.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createPublicClient,createWalletClient,http,parseAbi,encodeFunctionData,encodePacked,concatHex,padHex,toHex,parseEventLogs} from 'viem';
import {base} from 'viem/chains';
import {createV3Plan,snapshotMigration,verifyV3Deployments,prepareV3Stage,limitsObject,tokenAbi,feeAbi,serialize} from '../scripts/v3-migration.mjs';
import {prepareTwapKeeperV3,revalidateTwapKeeperV3} from '../scripts/twap-keeper-v3-plan.mjs';
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const C={...load('config/base.json'),...load('config/v3-migration.json'),logPageSize:process.env.BASE_LOG_PAGE_SIZE??100},A=load('build/all.json');
const url=new URL(process.env.LOCAL_FORK_RPC_URL??'http://127.0.0.1:18545');
assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Loopback Anvil only');
const transport=http(url.href,{timeout:600000,retryCount:0});
const pc=createPublicClient({chain:base,transport,cacheTime:0,pollingInterval:50});
const wc=createWalletClient({chain:base,transport});
const version=await pc.request({method:'web3_clientVersion'});assert.match(version,/^anvil\//);
const node=await pc.request({method:'anvil_nodeInfo'}),forkBlock=BigInt(process.env.BASE_FORK_BLOCK);
assert.equal(BigInt(node.forkConfig.forkBlockNumber),forkBlock);assert.equal(await pc.getBlockNumber(),forkBlock);
const upstream=createPublicClient({chain:base,transport:http(process.env.UPSTREAM_READ_RPC_URL,{timeout:120000,retryCount:0}),cacheTime:0});
console.log('[migration] read and reconcile pinned Base accounting state');
const snapshot=await snapshotMigration(upstream,C,A,forkBlock);
const report={mode:'LOCAL FORK ONLY — no live writes',block:forkBlock,blockHash:snapshot.blockHash,anvil:version,snapshot,
 fixtures:['Native ETH increased and a fixed local gas price used; real EOA Safe owners impersonated only on Anvil.',
 'Synthetic nonzero reward streams funded with tokens bought using fork-only ETH; no token/storage balances patched.',
 'Initial wiring requires no time advance; a separate later-change delay, original lock and reward periods are tested.',
 'Bounded real-pool swaps cross a tick and verify fresh observations after local time advances; oracle storage is not patched.',
 'User opt-in migration rehearsed with the Bankr position; no such withdrawal, approval or stake sent live.'],
 limitations:['Does not preserve the original lock timestamp: a V3 stake begins a fresh seven-day lock.',
 'Old BNKR queue, buyback reserve and reward dust remain protected in old contracts; they are not copied to V3.',
 'Safe hash approvals use impersonation; real Ledger/Rabby/phone signing and Bankr bundler latency are not tested.',
 'No external automation is changed. Cutover must be coordinated with repinning its reviewed command.',
 'No buyback deployment or activation is included.'],observations:{}};
let checks=0;const check=(condition,message)=>{assert(condition,message);checks++;console.log('  ok '+message);};
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();const ZERO='0x'+'0'.repeat(40),E18=10n**18n;
const abi=n=>A[n].abi;
const read=(address,contractAbi,functionName,args=[])=>pc.readContract({address,abi:contractAbi,functionName,args});
const call=(n,a,f,args=[])=>read(a,abi(n),f,args);
const balance=(token,who)=>read(token,tokenAbi,'balanceOf',[who]);
const allowance=(token,who,spender)=>read(token,tokenAbi,'allowance',[who,spender]);
const tx=(address,contractAbi,functionName,args=[])=>({to:address,value:0n,data:encodeFunctionData({abi:contractAbi,functionName,args})});
const [actor,outsider]=await pc.request({method:'eth_accounts'});
const deployer='0xa741dAd09fFF5de643283142eD339b9F0b52b146';
await pc.request({method:'anvil_setBlockTimestampInterval',params:[2]});
async function impersonate(address){await pc.request({method:'anvil_impersonateAccount',params:[address]});await pc.request({method:'anvil_setBalance',params:[address,toHex(100n*E18)]});}
async function send(request,account=actor){
 const hash=await wc.sendTransaction({...request,value:BigInt(request.value??0),account,gas:16000000n});
 // Manual local mining completes archive reads before receipt polling. Otherwise
 // Anvil can forward an as-yet-unmined local receipt lookup to the public fork RPC.
 await pc.request({method:'evm_mine',params:[]});
 const r=await pc.waitForTransactionReceipt({hash});
 if(r.status!=='success'){
  const trace=await pc.request({method:'debug_traceTransaction',params:[hash,{tracer:'callTracer'}]});
  writeFileSync('/tmp/staked-v3-migration-failed-trace.json',serialize(trace));
  throw new Error('Local transaction reverted; trace saved: '+hash);
 }
 return r;
}
const write=(a,b,f,args=[],from=actor)=>send(tx(a,b,f,args),from);
const safeAbi=parseAbi(['function getOwners() view returns(address[])','function getThreshold() view returns(uint256)','function nonce() view returns(uint256)',
 'function approveHash(bytes32)','function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)',
 'function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns(bool)','event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)']);
const safeOwners=[];
for(const owner of await read(C.safe,safeAbi,'getOwners')){const code=await pc.getBytecode({address:owner});if(!code||code==='0x')safeOwners.push(owner);}
safeOwners.sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
check(safeOwners.length>=2&&await read(C.safe,safeAbi,'getThreshold')===2n,'real Safe has two ordinary EOA owners and threshold two');
for(const a of [...safeOwners.slice(0,2),deployer,C.bankr])await impersonate(a);
// Covers native Optimism simulation fees for deliberately rejected inner calls;
// no Safe impersonation is used for execution or signature validation.
await pc.request({method:'anvil_setBalance',params:[C.safe,toHex(100n*E18)]});
const multisendAbi=parseAbi(['function multiSend(bytes transactions) payable']);
function safeFields(actions){
 const packed=concatHex(actions.map(a=>encodePacked(['uint8','address','uint256','uint256','bytes'],[0,a.to,BigInt(a.value??0),BigInt((a.data.length-2)/2),a.data])));
 return [C.multiSendCallOnly,0n,encodeFunctionData({abi:multisendAbi,functionName:'multiSend',args:[packed]}),1,0n,0n,0n,ZERO,ZERO];
}
async function safeBatch(actions,label){
 const fields=safeFields(actions),nonce=await read(C.safe,safeAbi,'nonce'),hash=await read(C.safe,safeAbi,'getTransactionHash',[...fields,nonce]);
 for(const owner of safeOwners.slice(0,2))await write(C.safe,safeAbi,'approveHash',[hash],owner);
 const signatures=concatHex(safeOwners.slice(0,2).map(owner=>concatHex([padHex(owner,{size:32}),toHex(0n,{size:32}),'0x01'])));
 // Simulate the full, signed Safe transaction before local execution.
 await pc.simulateContract({address:C.safe,abi:safeAbi,functionName:'execTransaction',args:[...fields,signatures],account:actor});
 const r=await write(C.safe,safeAbi,'execTransaction',[...fields,signatures]);
 check(parseEventLogs({abi:safeAbi,logs:r.logs,eventName:'ExecutionSuccess'}).length===1,label);return r;
}
async function deny(request,account,reason,label){await assert.rejects(pc.call({...request,account}),e=>String(e).includes(reason));check(true,label);}
async function warpTo(timestamp){await pc.request({method:'evm_setNextBlockTimestamp',params:[Number(timestamp)]});await pc.request({method:'evm_mine',params:[]});}
const principal=await call('StakedVault',C.vault,'balanceOf',[C.bankr]);
check(principal>0n&&principal===snapshot.vault.totalSupply,'fresh snapshot reconciles Bankr principal to all enumerated supply');
const personalLiquid=await balance(C.staked,C.bankr),personalUsdc=await balance(C.usdc,C.bankr);
const originalLock=await call('StakedVault',C.vault,'lockEnd',[C.bankr]);
const originalPenalty=await call('StakedVault',C.vault,'totalPenaltyBurned');
report.observations.initial={principal,personalLiquid,personalUsdc,originalLock,oldQueue:snapshot.distributor.pendingSwapBnkr};

console.log('[migration] deploy replacements from generated exact constructor bytes');
const plan=createV3Plan(C,A,deployer,await pc.getTransactionCount({address:deployer}),snapshot.distributor.minBnkrBatch,limitsObject(snapshot.keeper.limits));
const hashes=[];
for(const d of plan.deployments){const r=await send({data:d.data,nonce:d.nonce},deployer);check(same(r.contractAddress,d.address),d.name+' predicted address matches receipt');hashes.push(r.transactionHash);}
await pc.request({method:'evm_mine',params:[]});await verifyV3Deployments(pc,C,A,plan,hashes);check(true,'all five creation receipts, runtime bytes and immutable bindings verify');
const H=plan.addresses;
await assert.rejects(verifyV3Deployments(pc,C,A,{...plan,minBnkrBatch:'1'},hashes));check(true,'substituted constructor plan rejected');
check(same(await call('StakedVaultV3',H.vault,'distributor'),H.relay)&&same(await call('StakedDistributorV3',H.distributor,'vault'),H.relay)&&same(await call('StakedDistributorV3',H.distributor,'keeper'),H.keeper),'initial wiring is complete immediately after creation');
check((await pc.getBlock()).timestamp<snapshot.timestamp+172800n,'initial setup completes without a 48-hour time jump');
for(const stage of ['schedule','wire']){await assert.rejects(prepareV3Stage(pc,C,A,plan,hashes,stage),/constructor-only/);check(true,'obsolete '+stage+' migration stage rejected');}
const delayed=tx(H.vault,abi('StakedVaultV3'),'setDistributor',[H.relay]);
await deny(delayed,C.safe,'not scheduled','constructor wiring cannot be replayed through a setter');
await safeBatch([tx(H.vault,abi('StakedVaultV3'),'scheduleConfiguration',[delayed.data])],'later protected change can be scheduled through Safe');
await deny(delayed,C.safe,'configuration delay','later change cannot execute before 48 hours');
await warpTo((await pc.getBlock()).timestamp+172801n);
await safeBatch([delayed],'later protected change executes after its full delay');
await deny(delayed,C.safe,'not scheduled','later change cannot replay its consumed schedule');
await assert.rejects(prepareV3Stage(pc,C,A,plan,hashes,'cutover'),/opted-in V3 stake/);check(true,'cutover refuses an empty replacement vault');
check(await call('StakedTwapKeeperV3',H.keeper,'paused')&&same(await call('StakedTwapKeeperV3',H.keeper,'operator'),ZERO),'new path remains paused with no operator after deployment and later-change test');
check(await call('StakedVault',C.vault,'balanceOf',[C.bankr])===principal&&await balance(C.staked,C.bankr)===personalLiquid,'deployment and wiring leave old principal and personal liquid holdings intact');

console.log('[migration] fund nonzero reward fixtures through normal token transfers');
const quoterAbi=parseAbi(['function quoteExactInput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)']);
await send({...tx(C.weth,parseAbi(['function deposit() payable']),'deposit'),value:E18/2n});
async function buy(token,fee,amount){
 const available=await balance(C.weth,actor);
 if(available<amount)await send({...tx(C.weth,parseAbi(['function deposit() payable']),'deposit'),value:amount-available});
 const path=encodePacked(['address','uint24','address'],[C.weth,fee,token]);
 const quote=(await pc.simulateContract({address:C.v3Quoter,abi:quoterAbi,functionName:'quoteExactInput',args:[path,amount]})).result[0];
 await write(C.weth,tokenAbi,'approve',[C.v3Router,amount]);
 await write(C.v3Router,abi('ISwapRouter02'),'exactInput',[{path,recipient:actor,amountIn:amount,amountOutMinimum:quote*995n/1000n}]);
 return quote;
}
await buy(C.bnkr,10000,E18/5n);await buy(C.usdc,500,E18/100n);
const rewards={usdc:1000000n,bnkr:10n*E18};
for(const[t,amount]of Object.entries(rewards))await write(C[t],tokenAbi,'transfer',[C.safe,amount]);
await safeBatch(Object.entries(rewards).flatMap(([t,amount])=>[tx(C[t],tokenAbi,'approve',[C.vault,amount]),tx(C.vault,abi('StakedVault'),'notifyRewardAmount',[C[t],amount])]),'both old reward streams funded by Safe through normal APIs');
const finishes=await Promise.all([C.usdc,C.bnkr].map(t=>call('StakedVault',C.vault,'rewardData',[t])));
const maturity=[originalLock,...finishes.map(r=>r[0])].reduce((a,b)=>a>b?a:b);
await warpTo(maturity+1n);
const earnedBefore={usdc:await call('StakedVault',C.vault,'earned',[C.usdc,C.bankr]),bnkr:await call('StakedVault',C.vault,'earned',[C.bnkr,C.bankr])};
check(earnedBefore.usdc>0n&&earnedBefore.bnkr>0n,'nonzero original USDC and BNKR claims exist before opt-in migration');
const oldReserve=await call('StakedVault',C.vault,'buybackReserve');
await write(C.vault,abi('StakedVault'),'withdraw',[principal],C.bankr);
check(await balance(C.staked,C.bankr)===personalLiquid+principal,'mature original withdrawal returns every principal unit');
check(await call('StakedVault',C.vault,'totalPenaltyBurned')===originalPenalty,'mature migration burns no principal');
for(const[t,amount]of Object.entries(earnedBefore))check(await call('StakedVault',C.vault,'earned',[C[t],C.bankr])===amount,'old '+t+' claim survives full principal withdrawal');
await write(C.staked,tokenAbi,'approve',[H.vault,principal],C.bankr);
await write(H.vault,abi('StakedVaultV3'),'stake',[principal],C.bankr);
check(await call('StakedVaultV3',H.vault,'balanceOf',[C.bankr])===principal&&await balance(C.staked,C.bankr)===personalLiquid,'opt-in V3 re-stake preserves principal and original liquid STAKED balance');
check(await allowance(C.staked,C.bankr,H.vault)===0n,'exact re-stake allowance consumed');
check(await call('StakedVaultV3',H.vault,'lockEnd',[C.bankr])>originalLock,'re-stake explicitly starts a new seven-day lock');
await deny(tx(H.vault,abi('StakedVaultV3'),'withdraw',[1n]),C.bankr,'locked','ordinary V3 withdrawal cannot trigger a locked penalty');

const math=(await send({data:A.TwapMathHarness.bytecode})).contractAddress;
async function refreshPools(){
// Uniswap V3 writes a swap observation only when its tick changes. A dust swap
// can leave the observation days old after the lock/reward time jumps above.
// Use the existing math harness only for exact tick arithmetic, then make a
// normal, quoted WETH swap across one tick and verify the actual observation.

const ceil=(n,d)=>(n+d-1n)/d,Q96=1n<<96n;
for(const [token,fee,poolGetter]of[[C.bnkr,10000,'poolBnkrWeth'],[C.usdc,500,'poolWethUsdc']]){
 const pool=await call('StakedTwapKeeperV3',H.keeper,poolGetter);
 const slot=await call('TwapV3Pool',pool,'slot0'),oldObservation=await call('TwapV3Pool',pool,'observations',[slot[2]]);
 const zeroForOne=same(await call('TwapV3Pool',pool,'token0'),C.weth);
 const targetTick=Number(slot[1])+(zeroForOne?-1:1),target=await call('TwapMathHarness',math,'sqrt',[targetTick]);
 const liquidity=await call('TwapV3Pool',pool,'liquidity'),sqrt=slot[0];
 const net=zeroForOne?ceil(liquidity*Q96*(sqrt-target),sqrt*target):ceil(liquidity*(target-sqrt),Q96);
 const amount=ceil(net*1000000n,1000000n-BigInt(fee))+2n;
 check(amount>0n&&amount<=5n*E18,'oracle refresh fixture has bounded fork-only WETH input');
 const held=await balance(C.weth,actor);
 if(held<amount)await send({...tx(C.weth,parseAbi(['function deposit() payable']),'deposit'),value:amount-held});
 await buy(token,fee,amount);
 const after=await call('TwapV3Pool',pool,'slot0'),observation=await call('TwapV3Pool',pool,'observations',[after[2]]);
 check(after[1]!==slot[1]&&Math.abs(Number(after[1])-Number(slot[1]))<=3,'normal refresh swap moves the real pool by at most three ticks');
 check(observation[3]&&observation[0]>oldObservation[0]&&(await pc.getBlock()).timestamp-BigInt(observation[0])<=1800n,'real pool records a fresh initialized oracle observation');
}
}
console.log('[migration] real legacy spending immediately before fee cutover');
await refreshPools();
const legacyInput=BigInt(plan.reviewedLimits.maxBnkrPerSwap),legacyQueue=await call('StakedDistributor',C.distributor,'pendingSwapBnkr');
check(legacyQueue<legacyInput,'legacy queue can be topped up to the reviewed cap for the fork fixture');
const legacyFunding=2n*(legacyInput-legacyQueue);
if(await balance(C.bnkr,actor)<legacyFunding+4n*legacyInput)await buy(C.bnkr,10000,E18/2n);
await write(C.bnkr,tokenAbi,'transfer',[C.distributor,legacyFunding]);await write(C.distributor,abi('StakedDistributor'),'distribute',[],outsider);
check(await call('StakedDistributor',C.distributor,'pendingSwapBnkr')===legacyInput,'legacy fixture uses the actual whole-queue swap interface');
const legacyPath=await call('StakedDistributor',C.distributor,'swapPath');
const legacyQuote=(await pc.simulateContract({address:C.v3Quoter,abi:quoterAbi,functionName:'quoteExactInput',args:[legacyPath,legacyInput]})).result[0]*995n/1000n;
const legacyFloor=await call('StakedTwapKeeper',C.oldKeeper,'minimumUsdc',[legacyInput]);
await write(C.oldKeeper,abi('StakedTwapKeeper'),'swapAndNotify',[legacyInput,legacyQuote>legacyFloor?legacyQuote:legacyFloor,Number((await pc.getBlock()).timestamp+60n),await call('StakedTwapKeeper',C.oldKeeper,'nonce')],C.bankr);
check(await call('StakedTwapKeeper',C.oldKeeper,'spentLast24Hours')===legacyInput,'real legacy swap consumes budget immediately before cutover');
// Leave nonzero protected dust after the legacy trade. Cutover collection
// may legitimately grow this queue; it must never consume its existing amount.
await write(C.bnkr,tokenAbi,'transfer',[C.distributor,2n]);await write(C.distributor,abi('StakedDistributor'),'distribute',[],outsider);
const oldQueueAtCutover=await call('StakedDistributor',C.distributor,'pendingSwapBnkr');
check(oldQueueAtCutover>0n,'nonzero protected legacy queue remains before cutover');
console.log('[migration] atomic fee cutover; old claims remain accessible');
const cutover=await prepareV3Stage(pc,C,A,plan,hashes,'cutover');
await safeBatch(cutover.batch.transactions,'generated cutover executes as one real Safe transaction');
check(await call('StakedTwapKeeper',C.oldKeeper,'paused')&&same(await call('StakedTwapKeeper',C.oldKeeper,'operator'),ZERO),'old operator removed and old keeper paused');
check(!await call('StakedTwapKeeperV3',H.keeper,'paused')&&same(await call('StakedTwapKeeperV3',H.keeper,'operator'),C.bankr),'new keeper is the only enabled conversion operator path');
check(await read(C.initializer,feeAbi,'getShares',[C.poolId,H.collector])===950000000000000000n,'new collector owns exactly 95% after cutover');
const oldQueueAfterCutover=await call('StakedDistributor',C.distributor,'pendingSwapBnkr');
check(oldQueueAfterCutover>=oldQueueAtCutover,'old protected queue remains accounted for');
check(await balance(C.bnkr,C.distributor)>=oldQueueAfterCutover,'legacy queue remains fully backed after fee collection');
check(await call('StakedTwapKeeperV3',H.keeper,'spentLast24Hours')===legacyInput,'cutover preserves real legacy rolling spend');
check(await call('StakedVault',C.vault,'buybackReserve')===oldReserve,'old buyback reserve not swept');
await assert.rejects(prepareV3Stage(pc,C,A,plan,hashes,'cutover'));check(true,'completed cutover cannot be prepared again');
const rewardWalletBefore={usdc:await balance(C.usdc,C.bankr),bnkr:await balance(C.bnkr,C.bankr)};
await write(C.vault,abi('StakedVault'),'getReward',[],C.bankr);
for(const[t,amount]of Object.entries(earnedBefore))check(await balance(C[t],C.bankr)===rewardWalletBefore[t]+amount,'old '+t+' rewards can still be claimed after fee cutover');
report.observations.claimPreservation={earnedBefore,claimedAfterCutover:earnedBefore,oldReserve,oldQueueAfterCutover:await call('StakedDistributor',C.distributor,'pendingSwapBnkr'),newLock:await call('StakedVaultV3',H.vault,'lockEnd',[C.bankr])};

console.log('[migration] real pools, unchanged floors, bounded queue with late dust');
await warpTo(BigInt(await call('StakedTwapKeeper',C.oldKeeper,'lastExecution'))+BigInt(plan.reviewedLimits.minInterval));
await refreshPools();
const minBatch=BigInt(plan.minBnkrBatch),cap=BigInt(plan.reviewedLimits.maxBnkrPerSwap),donation=(cap+minBatch)*2n;
check(await balance(C.bnkr,actor)>donation,'fork-only donor can fund an over-cap queue');
await write(C.bnkr,tokenAbi,'transfer',[H.collector,donation]);await write(H.collector,abi('StakedFeeCollector'),'collectAndDistribute',[],C.bankr);
const queueBefore=await call('StakedDistributorV3',H.distributor,'pendingSwapBnkr');check(queueBefore>cap,'queue exceeds per-swap cap without changing limits');
const options={keeper:H.keeper,operator:C.bankr,safe:C.safe,distributor:H.distributor,v3Quoter:C.v3Quoter,slippageBps:50,maxBnkrPerBatch:minBatch};
const swap=await prepareTwapKeeperV3(pc,options);
await write(C.bnkr,tokenAbi,'transfer',[H.distributor,1n]);await write(H.distributor,abi('StakedDistributorV3'),'distribute',[],outsider);
await revalidateTwapKeeperV3(pc,swap,options);
const before=await balance(C.usdc,H.vault);
await send({to:swap.to,data:swap.data},C.bankr);
const delivered=await balance(C.usdc,H.vault)-before;
check(delivered>=swap.quotes.minimumUsdc,'real BNKR conversion reaches V3 vault above on-chain and quoted minimums');
check(await call('StakedDistributorV3',H.distributor,'pendingSwapBnkr')===queueBefore+1n-swap.quotes.bnkrIn,'prepared exact input succeeds after outsider dust; remainder stays queued');
check(await call('StakedTwapKeeperV3',H.keeper,'spentLast24Hours')===legacyInput+swap.quotes.bnkrIn,'rolling spend includes exact legacy and new inputs');
await deny(tx(H.keeper,abi('StakedTwapKeeperV3'),'swapAndNotify',[cap,1n,Number((await pc.getBlock()).timestamp+60n),await call('StakedTwapKeeperV3',H.keeper,'nonce')]),C.bankr,'spending cap','fresh keeper cannot spend a second full allowance after real cutover');
for(const[token,who,spender]of[[C.bnkr,H.distributor,C.v3Router],[C.usdc,H.distributor,H.relay],[C.usdc,H.relay,H.vault]])check(await allowance(token,who,spender)===0n,'transient route allowance cleared');
await deny(tx(H.distributor,abi('StakedDistributorV3'),'swapBatchAndNotify',[minBatch,1n]),C.bankr,'not keeper','Bankr cannot bypass guarded swap floors');
await deny(tx(H.keeper,abi('StakedTwapKeeperV3'),'setPaused',[false]),C.bankr,'not Safe','operator cannot unpause itself');
report.observations.swap={queueBefore,bnkrIn:swap.quotes.bnkrIn,minimumUsdc:swap.quotes.minimumUsdc,usdcReceived:delivered,queueAfter:await call('StakedDistributorV3',H.distributor,'pendingSwapBnkr')};

console.log('[migration] supported delayed configuration changes do not block recovery');
const changes=[tx(H.distributor,abi('StakedDistributorV3'),'setMinBnkrBatch',[minBatch+1n]),tx(H.distributor,abi('StakedDistributorV3'),'setSwapRouter',[C.v3Quoter])];
await safeBatch(changes.map(change=>tx(H.distributor,abi('StakedDistributorV3'),'scheduleConfiguration',[change.data])),'Safe schedules threshold and route changes');
await warpTo((await pc.getBlock()).timestamp+172801n);
await safeBatch(changes,'supported configuration changes execute after the full delay');
check(await call('StakedDistributorV3',H.distributor,'minBnkrBatch')===minBatch+1n,'batch threshold now differs from deployment');
await verifyV3Deployments(pc,C,A,plan,hashes);check(true,'deployment identity verification survives legitimate mutable changes');
console.log('[migration] rollback fee route without moving stakes or consuming old claims');
const rollback=await prepareV3Stage(pc,C,A,plan,hashes,'rollback');check(rollback.batch.transactions.length===4,'recovery does not call the changed distribution route');await safeBatch(rollback.batch.transactions,'generated rollback returns fee rights without enabling old trading');
check(await call('StakedTwapKeeperV3',H.keeper,'paused')&&same(await call('StakedTwapKeeperV3',H.keeper,'operator'),ZERO),'rollback disables new operator');
check(await call('StakedTwapKeeper',C.oldKeeper,'paused')&&same(await call('StakedTwapKeeper',C.oldKeeper,'operator'),ZERO),'rollback leaves old trading paused for a fresh decision');
check(await read(C.initializer,feeAbi,'getShares',[C.poolId,C.oldCollector])===950000000000000000n,'old collector fee share restored');
check(await call('StakedVaultV3',H.vault,'balanceOf',[C.bankr])===principal&&await balance(C.usdc,H.vault)>=delivered,'rollback preserves new stake and funded new reward backing');
check(await balance(C.staked,C.bankr)===personalLiquid,'all rehearsal stages preserve original liquid personal STAKED');
report.observations.rollback={newPrincipal:await call('StakedVaultV3',H.vault,'balanceOf',[C.bankr]),oldQueue:await call('StakedDistributor',C.distributor,'pendingSwapBnkr'),newQueue:await call('StakedDistributorV3',H.distributor,'pendingSwapBnkr')};
console.log('[migration] redeem replacement principal and rewards after rollback');
const newLock=await call('StakedVaultV3',H.vault,'lockEnd',[C.bankr]);
const newFinish=(await call('StakedVaultV3',H.vault,'rewardData',[C.usdc]))[0];
await warpTo((newLock>newFinish?newLock:newFinish)+1n);
const newEarned=await call('StakedVaultV3',H.vault,'earned',[C.usdc,C.bankr]);
const usdcBeforeExit=await balance(C.usdc,C.bankr);
check(newEarned>0n,'new guarded conversion produced a redeemable USDC claim');
await write(H.vault,abi('StakedVaultV3'),'exit',[],C.bankr);
check(await balance(C.staked,C.bankr)===personalLiquid+principal,'mature V3 exit returns every migrated principal unit after rollback');
check(await balance(C.usdc,C.bankr)===usdcBeforeExit+newEarned,'mature V3 exit pays the funded USDC claim after rollback');
check(await call('StakedVaultV3',H.vault,'totalPenaltyBurned')===0n,'neither mature migration nor final V3 exit burns principal');
report.observations.redemption={principalReturned:principal,usdcPaid:newEarned,newPrincipalAfterExit:await call('StakedVaultV3',H.vault,'balanceOf',[C.bankr])};
report.checks=checks;report.deploymentPlan=plan;report.localDeploymentHashes=hashes;
writeFileSync(process.env.V3_MIGRATION_REPORT??'/tmp/staked-v3-migration-fork.json',serialize(report));
console.log(`${checks} V3 migration fork checks passed; no live transactions sent.`);
