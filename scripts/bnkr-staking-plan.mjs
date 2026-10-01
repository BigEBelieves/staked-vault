import assert from 'node:assert/strict';
import {encodeFunctionData,keccak256,parseAbi} from 'viem';
const bAbi=parseAbi(['function stakeOf(address) view returns(uint256)','function earned(address) view returns(uint256)','function daysBehind() view returns(uint32)','function paused() view returns(bool)']);
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
function verifyRuntime(actual,artifact){
 assert(actual&&actual!=='0x','Adapter missing');let a=actual.slice(2).toLowerCase(),b=artifact.deployedBytecode.slice(2).toLowerCase();assert.equal(a.length,b.length,'Adapter runtime length');
 for(const refs of Object.values(artifact.immutableReferences??{}))for(const {start,length} of refs){const zero='0'.repeat(length*2);a=a.slice(0,start*2)+zero+a.slice((start+length)*2);b=b.slice(0,start*2)+zero+b.slice((start+length)*2);}
 assert.equal(a,b,'Adapter runtime mismatch');
}
/// Prepares ONE action, using one pinned block; callers must resolve outstanding submissions first.
export async function prepareBankrYieldAction(client,C,A,adapter,kind){
 assert(['advance','stake','harvest','relay'].includes(kind),'Unknown action');assert.equal(await client.getChainId(),8453);
 const blockNumber=await client.getBlockNumber(),block=await client.getBlock({blockNumber});
 const read=(address,abi,functionName,args=[])=>client.readContract({address,abi,functionName,args,blockNumber});
 const abi=A.StakedBankrStakingAdapter.abi;
 verifyRuntime(await client.getBytecode({address:adapter,blockNumber}),A.StakedBankrStakingAdapter);
 assert.equal(keccak256(await client.getBytecode({address:C.staking,blockNumber})),C.stakingCodeHash,'External staking code mismatch');
 for(const [f,expected] of [['safe',C.safe],['bnkr',C.bnkr],['staking',C.staking],['relay',C.relay],['operator',C.operator]])assert(same(await read(adapter,abi,f),expected),f+' mismatch');
 assert.equal(await read(adapter,abi,'stakingCodeHash'),C.stakingCodeHash,'Captured staking hash mismatch');
 assert(same(await read(C.vault,A.StakedVaultV3.abi,'owner'),C.safe));
 assert(same(await read(C.relay,A.StakedRewardRelay.abi,'safe'),C.safe));
 assert(same(await read(C.relay,A.StakedRewardRelay.abi,'bnkr'),C.bnkr));
 assert(same(await read(C.distributor,A.StakedDistributorV3.abi,'owner'),C.safe));
 assert(same(await read(C.distributor,A.StakedDistributorV3.abi,'bnkrStakingWallet'),adapter));
 assert(same(await read(C.distributor,A.StakedDistributorV3.abi,'vault'),C.relay));
 assert(same(await read(C.vault,A.StakedVaultV3.abi,'distributor'),C.relay));
 assert(same(await read(C.relay,A.StakedRewardRelay.abi,'vault'),C.vault));
 assert(same(await read(C.relay,A.StakedRewardRelay.abi,'distributor'),C.distributor));
 assert(await read(C.relay,A.StakedRewardRelay.abi,'yieldSource',[adapter]),'Yield source disabled');
 const daily=await read(adapter,abi,'maxStakePerDay'),cap=await read(adapter,abi,'maxPrincipal');
 assert.equal(daily,BigInt(C.proposedMaxStakePerDay)*10n**18n,'Daily policy changed');assert.equal(cap,BigInt(C.proposedMaxPrincipal)*10n**18n,'Exposure policy changed');
 const behind=await read(C.staking,bAbi,'daysBehind');
 let fn,args=[];const skip=reason=>({skipped:true,reason,kind,adapter,blockNumber,timestamp:block.timestamp});
 if(kind==='advance'){if(behind===0)return skip('caught up');fn='advanceStaking';args=[Math.min(behind,180)];}
 else {
  if(behind>180)return skip('staking requires catch-up');
  const last=await read(adapter,abi,kind==='stake'?'lastStake':kind==='harvest'?'lastHarvest':'lastRelay');
  if(last>0n&&block.timestamp<last+86400n)return skip('24-hour interval');
  if(kind==='stake'){
   if(await read(adapter,abi,'paused')||await read(C.staking,bAbi,'paused'))return skip('deposits paused');
   const active=await read(C.staking,bAbi,'stakeOf',[adapter]),cooling=await read(adapter,abi,'coolingPrincipal');
   if(active+cooling>=cap)return skip('principal cap');
   const idle=await read(adapter,abi,'idlePrincipal');const amount=[idle,daily,cap-active-cooling].reduce((a,b)=>a<b?a:b);
   if(amount===0n)return skip('no idle principal');fn='stakeFees';args=[amount];
  }else if(kind==='harvest'){
   if(await read(C.staking,bAbi,'earned',[adapter])===0n)return skip('no earned yield');fn='harvest';
  }else {if(await read(adapter,abi,'pendingYield')===0n)return skip('no reserved yield');fn='relayYield';}
 }
 await client.simulateContract({address:adapter,abi,functionName:fn,args,account:C.operator,value:0n,blockNumber});
 return {skipped:false,kind,adapter,blockNumber,timestamp:block.timestamp,to:adapter,from:C.operator,chainId:8453,value:0n,data:encodeFunctionData({abi,functionName:fn,args})};
}
export async function revalidateBankrYieldAction(client,C,A,proposal){
 assert(!proposal.skipped,'Cannot send skipped plan');const fresh=await prepareBankrYieldAction(client,C,A,proposal.adapter,proposal.kind);
 assert(!fresh.skipped,'Action no longer eligible: '+fresh.reason);
 assert(fresh.timestamp>=proposal.timestamp&&fresh.timestamp-proposal.timestamp<=60n,'Plan stale');
 for(const f of ['to','from','chainId','value','data'])assert.equal(fresh[f],proposal[f],f+' changed');return fresh;
}
