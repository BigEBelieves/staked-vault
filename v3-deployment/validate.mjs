import {DeploymentError} from '../deployment/engine.mjs';
import {encodeDeployData,encodeFunctionData,encodeFunctionResult,getAddress,getContractAddress} from 'viem';
const ZERO='0x'+'0'.repeat(40);
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const requireThat=(ok,message)=>{if(!ok)throw new DeploymentError(message);};
export function authenticateV3Plan(p,build){
 const {config:C,artifacts:A,reviewedLimits:L,minimum}=build;
 requireThat(p?.version===3&&p.chainId===8453,'Choose the current version-3 Base deployment plan.');
 const deployer=getAddress(p.deployer),n=BigInt(p.firstNonce);
 requireThat(![ZERO,C.safe,C.bankr].some(a=>same(a,deployer))&&n>=0n&&n+4n<=BigInt(Number.MAX_SAFE_INTEGER),'Invalid deployment account or nonce.');
 requireThat(same(p.safe,C.safe)&&p.minBnkrBatch===minimum&&canonical(p.reviewedLimits)===canonical(L),'Safe, batch threshold or reviewed limits differ from this release.');
 const keys=['vault','distributor','relay','keeper','collector'];
 const names=['StakedVaultV3','StakedDistributorV3','StakedRewardRelay','StakedTwapKeeperV3','StakedFeeCollector'];
 const H=Object.fromEntries(keys.map((k,i)=>[k,getContractAddress({from:deployer,nonce:n+BigInt(i)})]));
 requireThat(canonical(p.addresses)===canonical(H),'Predicted addresses do not match the deployment nonce.');
 const args=[
  [C.staked,C.usdc,C.bnkr,C.safe,H.relay],
  [C.staked,C.bnkr,C.usdc,C.weth,C.v3Router,H.relay,C.safe,BigInt(minimum),H.keeper],
  [C.safe,H.vault,H.distributor,C.usdc,C.bnkr],
  [C.safe,{distributor:H.distributor,relay:H.relay,bnkr:C.bnkr,weth:C.weth,usdc:C.usdc,router:C.v3Router,factory:C.v3Factory,predecessor:C.oldKeeper}],
  [C.safe,C.initializer,C.poolId,C.staked,C.bnkr,H.distributor]
 ];
 const deployments=names.map((name,i)=>({name,address:H[keys[i]],from:deployer,nonce:Number(n+BigInt(i)),value:'0',chainId:8453,data:encodeDeployData({abi:A[name].abi,bytecode:A[name].bytecode,args:args[i]})}));
 requireThat(canonical(p.deployments)===canonical(deployments),'Creation transactions differ from the reviewed build.');
 const expected=[
  {owner:C.safe,pendingOwner:ZERO,stakedToken:C.staked,bnkr:C.bnkr,usdc:C.usdc,distributor:H.relay,keeper:ZERO,buybackExecutor:ZERO,CONFIGURATION_DELAY:172800n},
  {owner:C.safe,pendingOwner:ZERO,stakedToken:C.staked,bnkr:C.bnkr,usdc:C.usdc,weth:C.weth,swapRouter:C.v3Router,vault:H.relay,keeper:H.keeper,liquidityWallet:C.safe,bnkrStakingWallet:C.safe,bnkrWethFee:10000,wethUsdcFee:500,minBnkrBatch:BigInt(minimum),batchSwapVersion:1n,CONFIGURATION_DELAY:172800n},
  {safe:C.safe,vault:H.vault,distributor:H.distributor,usdc:C.usdc,bnkr:C.bnkr},
  {safe:C.safe,distributor:H.distributor,relay:H.relay,bnkr:C.bnkr,weth:C.weth,usdc:C.usdc,router:C.v3Router,factory:C.v3Factory,predecessor:C.oldKeeper,paused:true,operator:ZERO,nonce:0n,lastExecution:0n},
  {safe:C.safe,initializer:C.initializer,poolId:C.poolId,staked:C.staked,bnkr:C.bnkr,distributor:H.distributor}
 ];
 const verification=names.map((name,i)=>({code:A[name].deployedBytecode,immutableSlots:Object.values(A[name].immutableReferences).flat(),calls:Object.entries(expected[i]).map(([functionName,result])=>({name:functionName,data:encodeFunctionData({abi:A[name].abi,functionName}),expected:encodeFunctionResult({abi:A[name].abi,functionName,result})}))}));
 // Never accept runtime masks, expected getter values or fee-oracle settings from the imported file.
 return {sourceCommit:build.sourceCommit,plan:{deployer,firstNonce:n.toString(),safe:getAddress(C.safe),addresses:H,deployments},verification,gasOracle:'0x420000000000000000000000000000000000000f',l1FeeSelector:'0xf1c7a58b'};
}
