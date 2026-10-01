// Read-only deployment proposal builder. Never signs or broadcasts.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createPublicClient,http,keccak256,encodeDeployData,encodeFunctionData,getContractAddress,parseUnits} from 'viem';
const C=JSON.parse(readFileSync('config/bnkr-staking.json')),A=JSON.parse(readFileSync('build/all.json'));
const [deployer,nonceText]=process.argv.slice(2);
assert(/^0x[0-9a-fA-F]{40}$/.test(deployer??''),'Usage: node scripts/prepare-bnkr-staking.mjs DEPLOYER NONCE');
assert(/^\d+$/.test(nonceText??''),'Explicit deployment nonce required');
const p=createPublicClient({transport:http(process.env.BASE_READ_RPC_URL??'https://mainnet.base.org',{timeout:30000,retryCount:1}),cacheTime:0});
assert.equal(await p.getChainId(),8453);const blockNumber=await p.getBlockNumber();const block=await p.getBlock({blockNumber});
const read=(address,name,functionName,args=[])=>p.readContract({address,abi:A[name].abi,functionName,args,blockNumber});
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const code=await p.getBytecode({address:C.staking,blockNumber});assert.equal(keccak256(code),C.stakingCodeHash,'Bankr code mismatch');
for(const fn of ['stakingToken','rewardsToken'])assert(same(await read(C.staking,'BankrStakingV3',fn),C.bnkr));
assert(same(await read(C.distributor,'StakedDistributorV3','owner'),C.safe));
assert(same(await read(C.distributor,'StakedDistributorV3','bnkrStakingWallet'),C.safe),'Existing destination changed: review before preparing');
assert(same(await read(C.distributor,'StakedDistributorV3','vault'),C.relay));
assert(same(await read(C.vault,'StakedVaultV3','distributor'),C.relay));
for(const fn of ['safe','bnkr','vault','distributor'])assert(same(await read(C.relay,'StakedRewardRelay',fn),C[fn]));
const nonce=Number(nonceText);assert(Number.isSafeInteger(nonce));
assert.equal(await p.getTransactionCount({address:deployer,blockTag:'pending'}),nonce,'Deployer pending nonce mismatch');
const adapter=getContractAddress({from:deployer,nonce:BigInt(nonce)});assert(!(await p.getBytecode({address:adapter,blockNumber})),'Address already occupied');
const data=(name,fn,args)=>encodeFunctionData({abi:A[name].abi,functionName:fn,args});
const action=(to,data)=>({to,value:'0',data});
const policy=data('StakedBankrStakingAdapter','setPolicy',[C.operator,parseUnits(C.proposedMaxStakePerDay,18),parseUnits(C.proposedMaxPrincipal,18)]);
const route=data('StakedDistributorV3','setBnkrStakingWallet',[adapter]);
const report={status:'REVIEW ONLY. Not a signed transaction. Revalidate all state before signing.',chainId:8453,blockNumber:String(blockNumber),blockHash:block.hash,adapter,
 deployment:{from:deployer,nonce,chainId:8453,value:'0',data:encodeDeployData({abi:A.StakedBankrStakingAdapter.abi,bytecode:A.StakedBankrStakingAdapter.bytecode,args:[C.safe,C.bnkr,C.staking,C.relay]})},
 scheduleAfterDeploymentVerification:[action(adapter,data('StakedBankrStakingAdapter','scheduleConfiguration',[policy])),action(C.distributor,data('StakedDistributorV3','scheduleConfiguration',[route]))],
 activateAfter48HoursAndFreshSimulation:[action(adapter,policy),action(C.relay,data('StakedRewardRelay','setYieldSource',[adapter,true])),action(C.distributor,route),action(adapter,data('StakedBankrStakingAdapter','setPaused',[false]))],
 pause:action(adapter,data('StakedBankrStakingAdapter','setPaused',[true])),
 limits:{daily:C.proposedMaxStakePerDay,principal:C.proposedMaxPrincipal},
 notes:['Schedules expire seven days after becoming ready.','No Safe BNKR transfer or personal asset transfer included.','Existing reward claims/stakes and USDC conversion remain in current contracts.','Bytecode, immutables and Safe ownership must be verified after deployment; this builder is not a deployment verifier.','Amounts from earlier fee collections in the Safe require separate explicit review before transfer.']};
mkdirSync('build',{recursive:true});writeFileSync('build/bnkr-staking-proposal.json',JSON.stringify(report,null,2));console.log('Prepared review-only proposal at build/bnkr-staking-proposal.json; no transaction sent.');
