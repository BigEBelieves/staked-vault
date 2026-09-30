// Read-only receipt/runtime/state verifier and Safe scheduling preparation.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {keccak256,encodeFunctionData,decodeFunctionResult,parseAbi} from 'viem';
import {assertRuntime,safeChecksum} from './deployment-plan.mjs';
const hash=process.argv[2];assert(/^0x[0-9a-fA-F]{64}$/.test(hash??''),'Full deployment hash required');
const C=JSON.parse(readFileSync('config/bnkr-staking.json')),A=JSON.parse(readFileSync('build/all.json'));
const P=JSON.parse(readFileSync('review/bnkr-unsigned/proposal.json'));
const payload=JSON.parse(readFileSync('bnkr-deployment/payload.json'));
const evidence=JSON.parse(readFileSync('review/bnkr-unsigned/preparation-evidence.json'));
function batch(requests){
 if(requests.length>1){const out=[];for(let i=0;i<requests.length;i+=1)out.push(...batch(requests.slice(i,i+1)));return out;}
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);
 const data=requests.map(([method,params],id)=>({jsonrpc:'2.0',id,method,params}));
 let raw;for(let attempt=0;attempt<4;attempt++){
 raw=JSON.parse(execFileSync('curl',['-fsS','--max-time','45',process.env.BASE_READ_RPC_URL??'https://mainnet.base.org','-H','Content-Type: application/json','--data',JSON.stringify(data)],{encoding:'utf8',maxBuffer:4*1024*1024}));
 const errors=Array.isArray(raw)?raw.filter(x=>x.error).map(x=>x.error):[raw.error];
 if(errors.some(e=>e&&[-32016,-32005,429].includes(e.code))&&attempt<3){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3000*2**attempt);continue;}break;}
 assert(Array.isArray(raw),'RPC batch required: '+JSON.stringify(raw));const byId=new Map(raw.map(x=>[x.id,x]));
 return requests.map((_,i)=>{const r=byId.get(i);assert(r&&'result'in r,JSON.stringify(r));return r.result;});
}
const [chain,head,receipt,tx]=batch([['eth_chainId',[]],['eth_blockNumber',[]],['eth_getTransactionReceipt',[hash]],['eth_getTransactionByHash',[hash]]]);
assert.equal(chain,'0x2105');assert(receipt&&tx,'Missing mined deployment');assert.equal(receipt.status,'0x1');
assert.equal(receipt.contractAddress.toLowerCase(),P.adapter.toLowerCase());assert.equal(tx.from.toLowerCase(),P.deployment.from.toLowerCase());assert.equal(tx.to,null);
assert.equal(BigInt(tx.nonce),BigInt(P.deployment.nonce));assert.equal(BigInt(tx.value),0n);assert.equal(tx.input.toLowerCase(),P.deployment.data.toLowerCase());assert.equal(BigInt(tx.chainId),8453n);
assert(BigInt(head)>=BigInt(receipt.blockNumber)+1n,'Wait for confirmation');
const checks=payload.verification[0].calls;
const safeAbi=parseAbi(['function getThreshold() view returns(uint256)','function getOwners() view returns(address[])','function nonce() view returns(uint256)']);
const reads=[...checks.map(c=>({label:'adapter.'+c.name,to:P.adapter,data:c.data,expected:c.expected})),
 ...[['StakedDistributorV3',C.distributor,'owner',C.safe],['StakedDistributorV3',C.distributor,'bnkrStakingWallet',C.safe],['StakedDistributorV3',C.distributor,'vault',C.relay],['StakedVaultV3',C.vault,'owner',C.safe],['StakedVaultV3',C.vault,'distributor',C.relay],['StakedRewardRelay',C.relay,'safe',C.safe],['StakedRewardRelay',C.relay,'vault',C.vault],['StakedRewardRelay',C.relay,'distributor',C.distributor]].map(([n,to,fn,value])=>({label:n+'.'+fn,to,data:encodeFunctionData({abi:A[n].abi,functionName:fn}),expected:'0x'+value.slice(2).toLowerCase().padStart(64,'0')}))];
const baseRequests=[['eth_getBlockByNumber',[head,false]],['eth_getBlockByNumber',[receipt.blockNumber,false]],['eth_getCode',[P.adapter,head]],['eth_getCode',[C.staking,head]]];
const results=batch([...baseRequests,...reads.map(c=>['eth_call',[{to:c.to,data:c.data},head]]),...['getThreshold','getOwners','nonce'].map(fn=>['eth_call',[{to:C.safe,data:encodeFunctionData({abi:safeAbi,functionName:fn})},head]])]);
const [snapshot,canonical,code,bankrCode]=results;assert.equal(canonical.hash,receipt.blockHash);assertRuntime(A.StakedBankrStakingAdapter,code,'live adapter');assert.equal(keccak256(code),evidence.runtimeHash);assert.equal(keccak256(bankrCode),C.stakingCodeHash);
reads.forEach((c,i)=>assert.equal(results[4+i].toLowerCase(),c.expected.toLowerCase(),c.label));
const offset=4+reads.length;const threshold=decodeFunctionResult({abi:safeAbi,functionName:'getThreshold',data:results[offset]});
const owners=decodeFunctionResult({abi:safeAbi,functionName:'getOwners',data:results[offset+1]});const nonce=decodeFunctionResult({abi:safeAbi,functionName:'nonce',data:results[offset+2]});
assert.equal(threshold,2n,'Safe threshold changed');assert.equal(owners.length,3,'Safe signer count changed');
const schedules=P.scheduleAfterDeploymentVerification;
const simulations=batch(schedules.map(t=>['eth_call',[{from:C.safe,to:t.to,data:t.data,value:'0x0'},head]]));
const ids=simulations.map((data,i)=>decodeFunctionResult({abi:A[i===0?'StakedBankrStakingAdapter':'StakedDistributorV3'].abi,functionName:'scheduleConfiguration',data}));
const ready=batch(schedules.map((t,i)=>['eth_call',[{to:t.to,data:encodeFunctionData({abi:A[i===0?'StakedBankrStakingAdapter':'StakedDistributorV3'].abi,functionName:'configurationReadyAt',args:[ids[i]]})},head]]));
ready.forEach(x=>assert.equal(BigInt(x),0n,'Configuration already scheduled'));
const [end]=batch([['eth_getBlockByNumber',[head,false]]]);assert.equal(end.hash,snapshot.hash,'Snapshot reorg');
const report={status:'DEPLOYED, PAUSED; SCHEDULING NOT EXECUTED',deploymentHash:hash,adapter:P.adapter,chainId:8453,deploymentBlock:String(BigInt(receipt.blockNumber)),snapshotBlock:String(BigInt(head)),snapshotHash:snapshot.hash,runtimeHash:keccak256(code),checkedGetters:reads.map(c=>c.label),safe:{address:C.safe,threshold:String(threshold),owners,nonce:String(nonce)},schedules:schedules.map((t,i)=>({to:t.to,id:ids[i],readyAt:'0',individualEthCall:'passed'})),limitations:['Each scheduling call simulated separately from the Safe; simulate the complete batch in Safe before signing.','48-hour countdown has NOT started.','No tokens moved or automation changed by this verifier.']};
const B={version:'1.0',chainId:'8453',createdAt:Number(BigInt(snapshot.timestamp))*1000,meta:{name:'STAKED BNKR — start 48-hour notice',description:`Verified adapter ${P.adapter}; Base snapshot ${BigInt(head)}; observed Safe nonce ${nonce}. Two scheduling calls only, no transfers or activation. Simulate complete batch before signing.`,createdFromSafeAddress:C.safe,createdFromOwnerAddress:''},transactions:schedules};B.meta.checksum=safeChecksum(B);
mkdirSync('review/bnkr-live',{recursive:true});writeFileSync('review/bnkr-live/deployment-verification.json',JSON.stringify(report,null,2)+'\n');writeFileSync('review/bnkr-live/safe-schedule.json',JSON.stringify(B,null,2)+'\n');
console.log(JSON.stringify({adapter:P.adapter,deploymentBlock:report.deploymentBlock,checkedGetters:reads.length,safeNonce:String(nonce),simulation:'both scheduling calls passed',countdown:'not started'},null,2));
