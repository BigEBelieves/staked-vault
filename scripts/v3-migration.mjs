// Read-only planning and verification. No keys, wallet clients or broadcast APIs.
import assert from 'node:assert/strict';
import {encodeDeployData,encodeFunctionData,getContractAddress,getAddress,keccak256,parseAbi} from 'viem';
import {assertRuntime,safeChecksum,ZERO,OTHER_BENEFICIARY} from './deployment-plan.mjs';

export const tokenAbi=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)','function transfer(address,uint256) returns(bool)']);
export const safeAbi=parseAbi(['function getOwners() view returns(address[])','function getThreshold() view returns(uint256)','function nonce() view returns(uint256)']);
export const feeAbi=parseAbi(['function getShares(bytes32,address) view returns(uint256)','function updateBeneficiary(bytes32,address)']);
const SHARE=950000000000000000n;
const eq=(a,b,label)=>assert.equal(typeof a==='string'?a.toLowerCase():a,typeof b==='string'?b.toLowerCase():b,label);
const limitsKeys=['maxBnkrPerSwap','maxBnkrPer24Hours','minLiquidityBnkrWeth','minLiquidityWethUsdc','minInterval','slippageBps','maxTickDeviation','maxInputReserveBps'];
export const limitsObject=values=>Object.fromEntries(limitsKeys.map((k,i)=>[k,values[i]]));
export const serialize=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';

export function createV3Plan(C,A,deployer,firstNonce,minBnkrBatch,reviewedLimits) {
 eq(C.chainId,8453,'Base only');deployer=getAddress(deployer);const n=BigInt(firstNonce),minimum=BigInt(minBnkrBatch);
 assert(![C.safe,C.bankr,ZERO].some(a=>a.toLowerCase()===deployer.toLowerCase()),'Separate ordinary deployment EOA required');
 assert(n>=0n && n+4n<=BigInt(Number.MAX_SAFE_INTEGER),'Invalid deployment nonce');assert(minimum>0n,'Positive batch threshold required');
 const L=Object.fromEntries(limitsKeys.map(k=>[k,BigInt(reviewedLimits[k]).toString()]));
 for(const k of limitsKeys.slice(0,4))assert(BigInt(L[k])>0n&&BigInt(L[k])<(1n<<128n),'Invalid cap/liquidity');
 assert(BigInt(L.maxBnkrPerSwap)>=minimum&&BigInt(L.maxBnkrPer24Hours)>=BigInt(L.maxBnkrPerSwap),'Invalid batch/caps');
 assert(Number(L.minInterval)>=900&&Number(L.minInterval)<=86400,'Invalid interval');
 assert(Number(L.slippageBps)>=0&&Number(L.slippageBps)<=100,'Invalid slippage');
 assert(Number(L.maxTickDeviation)>0&&Number(L.maxTickDeviation)<=100,'Invalid deviation');
 assert(Number(L.maxInputReserveBps)>0&&Number(L.maxInputReserveBps)<=20,'Invalid reserve cap');
 const keys=['vault','distributor','relay','keeper','collector'];
 const names=['StakedVaultV3','StakedDistributorV3','StakedRewardRelay','StakedTwapKeeperV3','StakedFeeCollector'];
 const H=Object.fromEntries(keys.map((key,i)=>[key,getContractAddress({from:deployer,nonce:n+BigInt(i)})]));
 const args=[
  [C.staked,C.usdc,C.bnkr,C.safe,H.relay],
  [C.staked,C.bnkr,C.usdc,C.weth,C.v3Router,H.relay,C.safe,minimum,H.keeper],
  [C.safe,H.vault,H.distributor,C.usdc,C.bnkr],
  [C.safe,{distributor:H.distributor,relay:H.relay,bnkr:C.bnkr,weth:C.weth,usdc:C.usdc,router:C.v3Router,factory:C.v3Factory,predecessor:C.oldKeeper}],
  [C.safe,C.initializer,C.poolId,C.staked,C.bnkr,H.distributor]
 ];
 return {version:3,chainId:8453,mode:'UNSIGNED proposed direct CREATE; addresses are predictions, not deployments',scope:'distribution-only V3; constructor wiring; future protected changes delayed 48 hours; buybacks disabled; no user assets moved',
  safe:getAddress(C.safe),deployer,firstNonce:n.toString(),minBnkrBatch:minimum.toString(),reviewedLimits:L,addresses:H,
  deployments:names.map((name,i)=>({name,address:H[keys[i]],from:deployer,nonce:Number(n+BigInt(i)),value:'0',chainId:8453,
   data:encodeDeployData({abi:A[name].abi,bytecode:A[name].bytecode,args:args[i]})}))};
}

export function validateV3Plan(C,A,plan) {assert.deepEqual(plan,createV3Plan(C,A,plan.deployer,plan.firstNonce,plan.minBnkrBatch,plan.reviewedLimits),'Plan differs from source/config/constructor inputs');}

export async function snapshotMigration(client,C,A,blockNumber) {
 eq(await client.getChainId(),8453,'Wrong chain');
 const block=await client.getBlock(blockNumber===undefined?{blockTag:'latest'}:{blockNumber:BigInt(blockNumber)});
 const read=(address,abi,functionName,args=[])=>client.readContract({address,abi,functionName,args,blockNumber:block.number});
 const call=(name,address,fn,args=[])=>read(address,A[name].abi,fn,args);
 const balance=(token,address)=>read(token,tokenAbi,'balanceOf',[address]);
 const fields=async(name,address,keys)=>Object.fromEntries(await Promise.all(keys.map(async k=>[k,await call(name,address,k)])));
 const [vault,distributor,keeper,owners,threshold,safeNonce]=await Promise.all([
  fields('StakedVault',C.vault,['owner','pendingOwner','totalSupply','distributor','keeper','buybackExecutor','buybackReserve','totalPenaltyBurned','totalUsdcForfeited','totalBnkrForfeited']),
  fields('StakedDistributor',C.distributor,['owner','pendingOwner','keeper','vault','pendingSwapBnkr','minBnkrBatch','swapRouter','liquidityWallet','bnkrStakingWallet','bnkrWethFee','wethUsdcFee']),
  fields('StakedTwapKeeper',C.oldKeeper,['safe','distributor','relay','operator','paused','nonce','limits','lastExecution','spentLast24Hours']),
  read(C.safe,safeAbi,'getOwners'),read(C.safe,safeAbi,'getThreshold'),read(C.safe,safeAbi,'nonce')]);
 const logs=[];const event=parseAbi(['event Staked(address indexed user,uint256 amount,uint256 newLockEnd)'])[0];
 // Scan all historical depositors, not just the wallet currently holding supply.
 const ranges=[];
 // Use the page size that passed provider preflight, with a conservative default.
 // Every block is scanned, including the final partial page.
 const page=BigInt(C.logPageSize??100);assert(page>=1n&&page<=2000n,'Invalid log page size');
 for(let from=BigInt(C.vaultDeploymentBlock);from<=block.number;from+=page)
  ranges.push({fromBlock:from,toBlock:from+page-1n<block.number?from+page-1n:block.number});
 for(let i=0;i<ranges.length;i+=4)
  for(const result of await Promise.all(ranges.slice(i,i+4).map(range=>client.getLogs({address:C.vault,event,...range}))))logs.push(...result);
 const addresses=[...new Set([...logs.map(l=>l.args.user?.toLowerCase()).filter(Boolean),C.bankr.toLowerCase()])];
 const stakers=await Promise.all(addresses.map(async address=>({address,
  principal:await call('StakedVault',C.vault,'balanceOf',[address]),lockEnd:await call('StakedVault',C.vault,'lockEnd',[address]),
  usdcEarned:await call('StakedVault',C.vault,'earned',[C.usdc,address]),bnkrEarned:await call('StakedVault',C.vault,'earned',[C.bnkr,address])})));
 eq(stakers.reduce((s,a)=>s+a.principal,0n),vault.totalSupply,'Staker enumeration does not reconcile to total supply');
 const rewardData={usdc:await call('StakedVault',C.vault,'rewardData',[C.usdc]),bnkr:await call('StakedVault',C.vault,'rewardData',[C.bnkr])};
 const balances={};
 for(const[name,address]of Object.entries({vault:C.vault,distributor:C.distributor,collector:C.oldCollector,bankr:C.bankr,safe:C.safe}))
  balances[name]=Object.fromEntries(await Promise.all(['staked','bnkr','usdc'].map(async t=>[t,await balance(C[t],address)])));
 assert(balances.vault.staked>=vault.totalSupply,'Old principal is undercollateralized');
 assert(balances.distributor.bnkr>=distributor.pendingSwapBnkr,'Old queue is undercollateralized');
 const rewardBacking={};
 for(const token of ['usdc','bnkr']){
  const [finish,rate,last,,undistributed]=rewardData[token];
  const accrued=stakers.reduce((s,a)=>s+a[token+'Earned'],0n);
  const scheduled=finish>block.timestamp?(finish-block.timestamp)*rate/(10n**18n):0n;
  const applicable=block.timestamp<finish?block.timestamp:finish;
  const idle=vault.totalSupply===0n&&applicable>last?(applicable-last)*rate/(10n**18n):0n;
  const reserve=token==='usdc'?vault.buybackReserve:0n;
  const minimumBacking=accrued+scheduled+undistributed+idle+reserve;
  assert(balances.vault[token]>=minimumBacking,'Old '+token+' reward liabilities exceed backing');
  rewardBacking[token]={accrued,scheduled,undistributed,uncheckpointedIdle:idle,reserve,minimumBacking,balance:balances.vault[token],roundingOrUnallocated:balances.vault[token]-minimumBacking};
 }
 const shares=Object.fromEntries(await Promise.all(Object.entries({collector:C.oldCollector,safe:C.safe,bankr:C.bankr,other:OTHER_BENEFICIARY}).map(async([k,a])=>[k,await read(C.initializer,feeAbi,'getShares',[C.poolId,a])])));
 const allowances=await Promise.all([[C.staked,C.distributor],[C.bnkr,C.distributor],[C.bnkr,C.vault]].map(async([token,spender])=>({token,spender,amount:await read(token,tokenAbi,'allowance',[C.bankr,spender])})));
 eq((await client.getBlock({blockNumber:block.number})).hash,block.hash,'Snapshot block reorganized');
 return {chainId:8453,block:block.number,blockHash:block.hash,timestamp:block.timestamp,vault,distributor,keeper,
  safe:{owners,threshold,nonce:safeNonce},stakers,rewardData,rewardBacking,balances,shares,allowances,
  custodyNote:'Read-only accounting snapshot. This snapshot authorizes no asset transfer.'};
}

// Verify creation provenance, exact runtime and immutable bindings only.
// Mutable operational settings are checked separately when preparing cutover.
export async function verifyV3Deployments(client,C,A,plan,hashes) {
 validateV3Plan(C,A,plan);eq(await client.getChainId(),8453,'Base only');
 assert(Array.isArray(hashes)&&hashes.length===5&&new Set(hashes).size===5,'Five distinct deployment hashes required');
 const block=await client.getBlock({blockTag:'latest'});
 const read=(address,abi,functionName,args=[])=>client.readContract({address,abi,functionName,args,blockNumber:block.number});
 const call=(name,address,fn,args=[])=>read(address,A[name].abi,fn,args);
 for(let i=0;i<5;i++){
  const d=plan.deployments[i];
  const [tx,receipt,code]=await Promise.all([client.getTransaction({hash:hashes[i]}),client.getTransactionReceipt({hash:hashes[i]}),client.getBytecode({address:d.address,blockNumber:block.number})]);
  eq(receipt.status,'success','Creation reverted');eq(tx.to,null,'Direct CREATE required');eq(tx.from,d.from,'Wrong deployer');eq(tx.nonce,d.nonce,'Wrong nonce');eq(tx.value,0n,'Nonzero deployment value');eq(tx.input,d.data,'Wrong creation bytes');eq(receipt.contractAddress,d.address,'Wrong address');
  assert(block.number>=receipt.blockNumber+1n,'Wait for another confirmation');eq((await client.getBlock({blockNumber:receipt.blockNumber})).hash,receipt.blockHash,'Creation reorg');assertRuntime(A[d.name],code,d.name);
 }
 const H=plan.addresses;
 for(const[name,address,values]of[
  ['StakedVaultV3',H.vault,{stakedToken:C.staked,bnkr:C.bnkr,usdc:C.usdc,CONFIGURATION_DELAY:172800n}],
  ['StakedDistributorV3',H.distributor,{stakedToken:C.staked,bnkr:C.bnkr,usdc:C.usdc,weth:C.weth,batchSwapVersion:1n,CONFIGURATION_DELAY:172800n}],
  ['StakedRewardRelay',H.relay,{safe:C.safe,vault:H.vault,distributor:H.distributor,usdc:C.usdc,bnkr:C.bnkr}],
  ['StakedTwapKeeperV3',H.keeper,{safe:C.safe,distributor:H.distributor,relay:H.relay,bnkr:C.bnkr,weth:C.weth,usdc:C.usdc,router:C.v3Router,factory:C.v3Factory,predecessor:C.oldKeeper}],
  ['StakedFeeCollector',H.collector,{safe:C.safe,initializer:C.initializer,poolId:C.poolId,staked:C.staked,bnkr:C.bnkr,distributor:H.distributor}]
 ])for(const[fn,v]of Object.entries(values))eq(await call(name,address,fn),v,name+'.'+fn);
 eq((await client.getBlock({blockNumber:block.number})).hash,block.hash,'Verification reorg');
 return {block,read,call};
}

// Only generates a Safe import after verifying actual receipts and the stage's
// live preconditions. Preview instructions are deliberately a separate format.
export async function prepareV3Stage(client,C,A,plan,hashes,stage) {
 assert(['cutover','rollback'].includes(stage),'Initial wiring is constructor-only; supported stages: cutover, rollback');
 const {block,read,call}=await verifyV3Deployments(client,C,A,plan,hashes);const H=plan.addresses;
 const add=(name,to,fn,args=[])=>({to,value:'0',data:encodeFunctionData({abi:A[name].abi,functionName:fn,args})});
 const owners=await read(C.safe,safeAbi,'getOwners');eq(owners.length,3,'Three Safe owners required');eq(await read(C.safe,safeAbi,'getThreshold'),2n,'2-of-3 required');
 assert(!owners.some(a=>a.toLowerCase()===C.bankr.toLowerCase()),'Bankr cannot be Safe signer');
 // Recovery needs only authenticated helper identities and fee rights, not
 // the original mutable vault/distributor configuration or a working swap route.
 for(const[name,address]of[['StakedTwapKeeper',C.oldKeeper],['StakedFeeCollector',C.oldCollector]])assertRuntime(A[name],await client.getBytecode({address,blockNumber:block.number}),name);
 eq(await call('StakedTwapKeeper',C.oldKeeper,'safe'),C.safe,'Old keeper authority');
 for(const[fn,value]of Object.entries({safe:C.safe,initializer:C.initializer,poolId:C.poolId,staked:C.staked,bnkr:C.bnkr,distributor:C.distributor}))eq(await call('StakedFeeCollector',C.oldCollector,fn),value,'Old collector identity: '+fn);
 const feeShare=address=>read(C.initializer,feeAbi,'getShares',[C.poolId,address]);
 eq(await feeShare(OTHER_BENEFICIARY),50000000000000000n,'Other beneficiary changed');eq(await feeShare(C.safe),0n,'Unexpected Safe fee rights');eq(await feeShare(C.bankr),0n,'Unexpected Bankr fee rights');
 eq(await feeShare(C.oldCollector),stage==='rollback'?0n:SHARE,'Old fee rights');eq(await feeShare(H.collector),stage==='rollback'?SHARE:0n,'New fee rights');
 const paused=await call('StakedTwapKeeperV3',H.keeper,'paused');const operator=await call('StakedTwapKeeperV3',H.keeper,'operator');
 let transactions=[];
  if(stage==='cutover'){
   for(const[name,address]of[['StakedVault',C.vault],['StakedDistributor',C.distributor]]){
    eq(await call(name,address,'owner'),C.safe,'Old owner changed');eq(await call(name,address,'pendingOwner'),ZERO,'Old pending owner');
   }
   eq(await call('StakedDistributor',C.distributor,'keeper'),C.oldKeeper,'Old keeper changed');
   for(const[fn,value]of Object.entries({swapRouter:C.v3Router,liquidityWallet:C.safe,bnkrStakingWallet:C.safe,bnkrWethFee:10000,wethUsdcFee:500}))eq(await call('StakedDistributor',C.distributor,fn),value,'Old route changed: '+fn);
   eq(await call('StakedTwapKeeper',C.oldKeeper,'safe'),C.safe,'Old keeper authority');
   eq(await call('StakedTwapKeeper',C.oldKeeper,'distributor'),C.distributor,'Old keeper route');
   eq(await call('StakedFeeCollector',C.oldCollector,'safe'),C.safe,'Old collector authority');
   eq(await call('StakedFeeCollector',C.oldCollector,'distributor'),C.distributor,'Old collector route');
   for(const[name,address]of[['StakedTwapKeeper',C.oldKeeper],['StakedFeeCollector',C.oldCollector]])assertRuntime(A[name],await client.getBytecode({address,blockNumber:block.number}),name);
   const oldGuard=await call('StakedVault',C.vault,'keeper');
   eq(await call('StakedAutomationGuard',oldGuard,'paused'),true,'Old buybacks must remain paused');eq(await call('StakedAutomationGuard',oldGuard,'operator'),ZERO,'Old buyback operator');

   for(const[name,address,values]of[
    ['StakedVaultV3',H.vault,{owner:C.safe,pendingOwner:ZERO,distributor:H.relay,keeper:ZERO,buybackExecutor:ZERO}],
    ['StakedDistributorV3',H.distributor,{owner:C.safe,pendingOwner:ZERO,swapRouter:C.v3Router,vault:H.relay,keeper:H.keeper,liquidityWallet:C.safe,bnkrStakingWallet:C.safe,bnkrWethFee:10000,wethUsdcFee:500,minBnkrBatch:BigInt(plan.minBnkrBatch)}]
   ])for(const[fn,value]of Object.entries(values))eq(await call(name,address,fn),value,'Initial configuration: '+fn);

   eq(paused,true,'New keeper must still be paused');eq(operator,ZERO,'New operator already set');
   assert(await call('StakedVaultV3',H.vault,'totalSupply')>0n,'Require an opted-in V3 stake before redirecting rewards');
   const limits=limitsObject(await call('StakedTwapKeeper',C.oldKeeper,'limits'));
   for(const key of limitsKeys)eq(BigInt(limits[key]),BigInt(plan.reviewedLimits[key]),'Reviewed limit changed: '+key);
   eq(await call('StakedDistributor',C.distributor,'minBnkrBatch'),BigInt(plan.minBnkrBatch),'Old batch threshold changed');
   assert(BigInt(limits.maxBnkrPerSwap)>=BigInt(plan.minBnkrBatch),'Unchanged cap below threshold');
   transactions=[add('StakedTwapKeeper',C.oldKeeper,'setPaused',[true]),add('StakedTwapKeeper',C.oldKeeper,'setOperator',[ZERO]),
    add('StakedFeeCollector',C.oldCollector,'collectAndDistribute'),add('StakedFeeCollector',C.oldCollector,'returnBeneficiaryToSafe'),
    {to:C.initializer,value:'0',data:encodeFunctionData({abi:feeAbi,functionName:'updateBeneficiary',args:[C.poolId,H.collector]})},
    add('StakedTwapKeeperV3',H.keeper,'setLimits',[limits]),add('StakedTwapKeeperV3',H.keeper,'setOperator',[C.bankr]),add('StakedTwapKeeperV3',H.keeper,'setPaused',[false])];
  }else{
   eq(await call('StakedTwapKeeper',C.oldKeeper,'paused'),true,'Old trading must remain paused during rollback');
   eq(await call('StakedTwapKeeper',C.oldKeeper,'operator'),ZERO,'Old operator already restored');
   transactions=[add('StakedTwapKeeperV3',H.keeper,'setPaused',[true]),add('StakedTwapKeeperV3',H.keeper,'setOperator',[ZERO]),
    add('StakedFeeCollector',H.collector,'returnBeneficiaryToSafe'),
    {to:C.initializer,value:'0',data:encodeFunctionData({abi:feeAbi,functionName:'updateBeneficiary',args:[C.poolId,C.oldCollector]})}];
  }
 const safeNonce=await read(C.safe,safeAbi,'nonce');
 const batch={version:'1.0',chainId:'8453',createdAt:Number(block.timestamp)*1000,meta:{name:'V3 migration — '+stage,
  description:'Regenerate and simulate against fresh state before signing. Distribution only; no user withdrawals or buyback activation.',txBuilderVersion:'1.18.0',createdFromSafeAddress:C.safe,createdFromOwnerAddress:''},transactions};
 batch.meta.checksum=safeChecksum(batch);
 eq((await client.getBlock({blockNumber:block.number})).hash,block.hash,'Stage snapshot reorg');
 return {batch,verification:{stage,block:block.number,blockHash:block.hash,safeNonce,initialWiring:'constructor-only',futureConfigurationDelaySeconds:172800,
  aggregateSpend:await call('StakedTwapKeeperV3',H.keeper,'spentLast24Hours'),effectiveLastExecution:await call('StakedTwapKeeperV3',H.keeper,'effectiveLastExecution'),
  oldQueue:await call('StakedDistributor',C.distributor,'pendingSwapBnkr'),oldSupply:await call('StakedVault',C.vault,'totalSupply'),
  note:'State checks only. Complete Safe batch must be simulated near signing. Old queue/reserves and claims remain in old contracts. External scheduler must be repinned separately.',liveTransactionSent:false}};
}
