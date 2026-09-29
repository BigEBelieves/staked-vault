import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {encodeFunctionData,encodeFunctionResult,parseAbi} from 'viem';
import {validatePlan,ZERO,json} from './deployment-plan.mjs';
const [planPath,sourceCommit]=process.argv.slice(2);
if(!planPath||!/^\w{40}$/.test(sourceCommit??''))throw new Error('Usage: node scripts/build-deployment-page.mjs PLAN.json SOURCE_COMMIT');
const C=JSON.parse(readFileSync('config/base.json')),A=JSON.parse(readFileSync('build/all.json'));
const plan=JSON.parse(readFileSync(planPath));validatePlan(C,A,plan);
const H=plan.addresses;
const expected=[
 {safe:C.safe,vault:C.vault,distributor:C.distributor,usdc:C.usdc,bnkr:C.bnkr},
 {safe:C.safe,vault:C.vault,distributor:C.distributor,paused:true,operator:ZERO,executor:ZERO,nonce:0n,remainingBnkr:0n,remainingUsdc:0n},
 {safe:C.safe,vault:C.vault,guard:H.guard,usdc:C.usdc,weth:C.weth,bnkr:C.bnkr,staked:C.staked,router:C.v3Router,poolManager:C.poolManager,feeUsdcWeth:C.feeUsdcWeth,feeWethBnkr:C.feeWethBnkr,bnkrIsCurrency0:BigInt(C.bnkr)<BigInt(C.staked),poolKey:[C.poolKey.currency0,C.poolKey.currency1,C.poolKey.fee,C.poolKey.tickSpacing,C.poolKey.hooks]},
 {safe:C.safe,initializer:C.initializer,poolId:C.poolId,staked:C.staked,bnkr:C.bnkr,distributor:C.distributor}
];
const verification=plan.deployments.map((d,i)=>({code:A[d.name].deployedBytecode,
 immutableSlots:Object.values(A[d.name].immutableReferences).flat(),
 calls:Object.entries(expected[i]).map(([name,result])=>({name,data:encodeFunctionData({abi:A[d.name].abi,functionName:name}),expected:encodeFunctionResult({abi:A[d.name].abi,functionName:name,result})}))}));
const l1FeeSelector=encodeFunctionData({abi:parseAbi(['function getL1FeeUpperBound(uint256) view returns(uint256)']),functionName:'getL1FeeUpperBound',args:[0n]}).slice(0,10);
const payload={sourceCommit,plan,verification,gasOracle:'0x420000000000000000000000000000000000000f',l1FeeSelector};
const content=json(payload),sha=createHash('sha256').update(content).digest('hex');
mkdirSync('deployment',{recursive:true});writeFileSync('deployment/payload.json',content);
writeFileSync('deployment/payload-digest.mjs',`export const payloadSha256 = '${sha}';\n`);
console.log(json({sourceCommit,sha,nonces:plan.deployments.map(d=>d.nonce),bytes:content.length}));
