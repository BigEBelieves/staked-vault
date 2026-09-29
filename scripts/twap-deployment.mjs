// Unsigned deployment and Safe batch generation. No keys or broadcasting.
import assert from 'node:assert/strict';
import {encodeDeployData,encodeFunctionData,getAddress,getContractAddress,parseAbi} from 'viem';
import {assertRuntime,safeChecksum,ZERO,feeAbi} from './deployment-plan.mjs';

const same=(a,b,label)=>assert.equal(typeof a==='string'?a.toLowerCase():a,typeof b==='string'?b.toLowerCase():b,label);
const safeAbi=parseAbi(['function getOwners() view returns(address[])','function getThreshold() view returns(uint256)','function nonce() view returns(uint256)']);
const tokenAbi=parseAbi(['function allowance(address,address) view returns(uint256)']);
export function createTwapDeployment(C,A,deployer,nonce) {
 assert.equal(C.chainId,8453);
 deployer=getAddress(deployer);nonce=BigInt(nonce);
 assert(nonce>=0n&&nonce<=BigInt(Number.MAX_SAFE_INTEGER),'Invalid nonce');
 assert(![C.safe,C.bankr].some(a=>a.toLowerCase()===deployer.toLowerCase()),'Use separate ordinary EOA');
 const config={distributor:C.distributor,relay:C.relay,bnkr:C.bnkr,weth:C.weth,usdc:C.usdc,router:C.v3Router,factory:C.factory};
 const args=[C.safe,config],name='StakedTwapKeeper';
 const address=getContractAddress({from:deployer,nonce});
 const d={name,address,from:deployer,nonce:Number(nonce),value:'0',chainId:8453,args,
  data:encodeDeployData({abi:A[name].abi,bytecode:A[name].bytecode,args})};
 return {version:1,chainId:8453,safe:C.safe,deployer,firstNonce:nonce.toString(),addresses:{keeper:address},deployments:[d]};
}
export async function verifyTwapDeployment(client,C,A,plan,hash) {
 assert.deepEqual(plan,createTwapDeployment(C,A,plan.deployer,plan.firstNonce),'Plan differs from source/config');
 assert.equal(await client.getChainId(),8453);
 const d=plan.deployments[0],block=await client.getBlock({blockTag:'latest'});
 const [tx,receipt,code]=await Promise.all([client.getTransaction({hash}),client.getTransactionReceipt({hash}),client.getBytecode({address:d.address,blockNumber:block.number})]);
 same(receipt.status,'success','Deployment reverted');same(tx.to,null,'Direct CREATE required');
 same(tx.from,d.from,'Wrong deployer');same(tx.nonce,d.nonce,'Wrong nonce');same(tx.value,0n,'Wrong value');same(tx.input,d.data,'Wrong creation bytes');
 same(receipt.contractAddress,d.address,'Wrong deployed address');
 assert(block.number>=receipt.blockNumber+1n,'Wait for another confirmation');
 same((await client.getBlock({blockNumber:receipt.blockNumber})).hash,receipt.blockHash,'Creation reorg');
 assertRuntime(A.StakedTwapKeeper,code,'TWAP keeper');
 const read=(address,name,functionName,args=[])=>client.readContract({address,abi:A[name].abi,functionName,args,blockNumber:block.number});
 const values={safe:C.safe,...d.args[1]};
 for(const [fn,v] of Object.entries(values))same(await read(d.address,d.name,fn),v,'Keeper '+fn);
 same((await client.getBlock({blockNumber:block.number})).hash,block.hash,'Snapshot reorg');
 return {block,read,receipt};
}
export async function prepareTwapActivation(client,C,A,plan,hash,limits) {
 const {block,read,receipt}=await verifyTwapDeployment(client,C,A,plan,hash);
 const keeper=plan.addresses.keeper;
 const readAbi=(address,abi,functionName,args=[])=>client.readContract({address,abi,functionName,args,blockNumber:block.number});
 const owners=await readAbi(C.safe,safeAbi,'getOwners');
 same(owners.length,3,'Expected three owners');same(await readAbi(C.safe,safeAbi,'getThreshold'),2n,'Expected 2-of-3 Safe');
 assert(!owners.some(a=>a.toLowerCase()===C.bankr.toLowerCase()),'Bankr must not be Safe signer');
 for(const [name,address] of [['StakedVault',C.vault],['StakedDistributor',C.distributor]]) {
  same(await read(address,name,'owner'),C.safe,'Safe owner');same(await read(address,name,'pendingOwner'),ZERO,'Pending owner');
  same(await read(address,name,'keeper'),C.oldGuard,'Existing keeper changed');
 }
 for(const [name,address,values] of [
  ['StakedRewardRelay',C.relay,{safe:C.safe,vault:C.vault,distributor:C.distributor,bnkr:C.bnkr,usdc:C.usdc}],
  ['StakedFeeCollector',C.collector,{safe:C.safe,initializer:C.initializer,poolId:C.poolId,distributor:C.distributor,bnkr:C.bnkr,staked:C.staked}],
  ['StakedAutomationGuard',C.oldGuard,{safe:C.safe,vault:C.vault,distributor:C.distributor,paused:true,remainingBnkr:0n,remainingUsdc:0n}]
 ]) {
  assertRuntime(A[name],await client.getBytecode({address,blockNumber:block.number}),name);
  for(const [fn,v] of Object.entries(values))same(await read(address,name,fn),v,name+'.'+fn);
 }
 same(await read(C.vault,'StakedVault','distributor'),C.relay,'Vault relay');
 for(const [fn,v] of Object.entries({vault:C.relay,swapRouter:C.v3Router,bnkr:C.bnkr,weth:C.weth,usdc:C.usdc,bnkrWethFee:10000,wethUsdcFee:500,liquidityWallet:C.safe,bnkrStakingWallet:C.safe}))
  same(await read(C.distributor,'StakedDistributor',fn),v,'Distributor '+fn);
 for(const [who,share] of [[C.collector,950000000000000000n],[C.safe,0n],[C.bankr,0n]])
  same(await readAbi(C.initializer,feeAbi,'getShares',[C.poolId,who]),share,'Fee rights');
 for(const [token,spender] of [[C.staked,C.distributor],[C.bnkr,C.distributor],[C.bnkr,C.vault]])
  same(await readAbi(token,tokenAbi,'allowance',[C.bankr,spender]),0n,'Bankr allowance');
 for(const [fn,v] of Object.entries({paused:true,operator:ZERO,nonce:0n,lastExecution:0,spentLast24Hours:0n}))
  same(await read(keeper,'StakedTwapKeeper',fn),v,'New keeper already configured');
 const threshold=await read(C.distributor,'StakedDistributor','minBnkrBatch');
 const queue=await read(C.distributor,'StakedDistributor','pendingSwapBnkr');
 assert(BigInt(limits.maxBnkrPerSwap)>=threshold && BigInt(limits.maxBnkrPerSwap)>=queue,'Cap below production threshold or queue');
 // This simulates an inner Safe call, not a transaction paid for by the Safe.
 // Optimism simulation can charge L1 fees even with gasPrice zero: override only
 // native balance for this read-only call. No code, storage or authorization override.
 await client.simulateContract({address:keeper,abi:A.StakedTwapKeeper.abi,functionName:'setLimits',args:[limits],account:C.safe,
  gasPrice:0n,stateOverride:[{address:C.safe,balance:10n**18n}],blockNumber:block.number});
 const transactions=[];
 const add=(name,to,fn,args)=>transactions.push({to,value:'0',data:encodeFunctionData({abi:A[name].abi,functionName:fn,args})});
 add('StakedAutomationGuard',C.oldGuard,'setOperator',[ZERO]);
 add('StakedTwapKeeper',keeper,'setLimits',[limits]);
 add('StakedTwapKeeper',keeper,'setOperator',[C.bankr]);
 add('StakedDistributor',C.distributor,'setKeeper',[keeper]);
 add('StakedTwapKeeper',keeper,'setPaused',[false]);
 const nonce=await readAbi(C.safe,safeAbi,'nonce');
 const batch={version:'1.0',chainId:'8453',createdAt:Number(block.timestamp)*1000,
  meta:{name:'Enable protected automatic BNKR conversion',description:'Distribution only. Existing buybacks stay paused. Verify and simulate before signing.',txBuilderVersion:'1.18.0',createdFromSafeAddress:C.safe,createdFromOwnerAddress:''},transactions};
 batch.meta.checksum=safeChecksum(batch);
 same((await client.getBlock({blockNumber:block.number})).hash,block.hash,'Snapshot reorg');
 return {batch,verification:{block:block.number,blockHash:block.hash,safeNonce:nonce,deploymentHash:receipt.transactionHash,keeper,limits,queue,threshold,
  simulation:'setLimits inner-call simulation with native Safe balance overridden for gas; complete Safe batch must be simulated separately.',liveTransactionSent:false}};
}
