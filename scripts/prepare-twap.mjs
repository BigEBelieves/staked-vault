// Read-only CLI. User signs creation and Safe activation separately.
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createPublicClient,http,encodeFunctionData,encodeFunctionResult,parseAbi} from 'viem';
import {base} from 'viem/chains';
import {createTwapDeployment,verifyTwapDeployment,prepareTwapActivation} from './twap-deployment.mjs';
import {prepareTwapKeeper} from './twap-keeper-plan.mjs';
import {assertRuntime,json,ZERO} from './deployment-plan.mjs';
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const A=load('build/all.json'),C0=load('config/base.json'),H=load('deployment/payload.json').plan.addresses;
const C={...C0,relay:H.relay,collector:H.collector,oldGuard:H.guard,factory:'0x33128a8fC17869897dcE68Ed026d694621f6FDfD'};
const usage='Set BASE_READ_RPC_URL. Commands: plan DEPLOYER OUTPUT.json | verify PAYLOAD.json HASH | batch PAYLOAD.json HASH LIMITS.json OUTPUT.json | swap KEEPER';
async function main() {
 const [mode,...args]=process.argv.slice(2);
 if(!process.env.BASE_READ_RPC_URL)throw new Error(usage);
 const client=createPublicClient({chain:base,transport:http(process.env.BASE_READ_RPC_URL,{retryCount:0,timeout:60000}),cacheTime:0});
 if(await client.getChainId()!==8453)throw new Error('Base only');
 if(mode==='plan'&&args.length===2) {
  const [deployer,out]=args;
  const code=await client.getBytecode({address:deployer});
  if(code&&code!=='0x')throw new Error('Use an ordinary EOA, not delegated or contract account');
  const nonce=await client.getTransactionCount({address:deployer,blockTag:'latest'});
  if(nonce!==await client.getTransactionCount({address:deployer,blockTag:'pending'}))throw new Error('Pending deployment-wallet transactions');
  const plan=createTwapDeployment(C,A,deployer,nonce),d=plan.deployments[0];
  const existing=await client.getBytecode({address:d.address});if(existing&&existing!=='0x')throw new Error('Predicted address occupied');
  const result=await client.call({account:deployer,data:d.data,value:0n,gas:12000000n});
  assertRuntime(A.StakedTwapKeeper,result.data,'creation simulation');
  const expected={safe:C.safe,...d.args[1],paused:true,operator:ZERO,nonce:0n,lastExecution:0,spentLast24Hours:0n};
  const verification=[{code:A.StakedTwapKeeper.deployedBytecode,immutableSlots:Object.values(A.StakedTwapKeeper.immutableReferences).flat(),
   calls:Object.entries(expected).map(([name,result])=>({name,data:encodeFunctionData({abi:A.StakedTwapKeeper.abi,functionName:name}),expected:encodeFunctionResult({abi:A.StakedTwapKeeper.abi,functionName:name,result})}))}];
  const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(execFileSync('git',['status','--porcelain','--','contracts','scripts','package.json','package-lock.json'],{encoding:'utf8'}).trim())throw new Error('Commit source changes before labeling the deployment build');
  const selector=encodeFunctionData({abi:parseAbi(['function getL1FeeUpperBound(uint256) view returns(uint256)']),functionName:'getL1FeeUpperBound',args:[0n]}).slice(0,10);
  writeFileSync(out,json({sourceCommit,plan,verification,gasOracle:'0x420000000000000000000000000000000000000f',l1FeeSelector:selector}),{flag:'wx'});
  console.log('Saved one unsigned, simulated creation. It starts paused with no operator. Nothing sent.');
 } else if(mode==='verify'&&args.length===2) {
  const r=await verifyTwapDeployment(client,C,A,load(args[0]).plan,args[1]);
  console.log(json({block:r.block.number,hash:r.receipt.transactionHash,verified:true}));
 } else if(mode==='batch'&&args.length===4) {
  const limits=load(args[2]);for(const key of ['maxBnkrPerSwap','maxBnkrPer24Hours','minLiquidityBnkrWeth','minLiquidityWethUsdc']) {
   if(typeof limits[key]!=='string'||!/^\d+$/.test(limits[key]))throw new Error(key+' must be a decimal raw-unit string');
   limits[key]=BigInt(limits[key]);
  }
  const r=await prepareTwapActivation(client,C,A,load(args[0]).plan,args[1],limits);
  writeFileSync(args[3],json(r.batch),{flag:'wx'});writeFileSync(args[3]+'.verification.json',json(r.verification),{flag:'wx'});
  console.log('Saved unsigned Safe activation batch. Simulate the complete batch in Safe before signing. Nothing sent.');
 } else if(mode==='swap'&&args.length===1) {
  console.log(json(await prepareTwapKeeper(client,{keeper:args[0],operator:C.bankr,safe:C.safe,distributor:C.distributor,v3Quoter:C.v3Quoter,slippageBps:50})));
 } else throw new Error(usage);
}
main().catch(e=>{console.error(e.shortMessage??e.message);process.exitCode=1;});
