// Packages one inactive CREATE. No wallet, signing, broadcasting or activation here.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {encodeDeployData,encodeFunctionData,encodeFunctionResult,getContractAddress} from 'viem';
const [proposalPath,sourceCommit]=process.argv.slice(2);
assert(proposalPath&&/^[0-9a-f]{40}$/.test(sourceCommit??''),'Provide proposal path and full reviewed source SHA');
const P=JSON.parse(readFileSync(proposalPath)),C=JSON.parse(readFileSync('config/bnkr-staking.json'));
const A=JSON.parse(readFileSync('build/all.json')).StakedBankrStakingAdapter;
assert.equal(P.chainId,8453);assert.equal(P.deployment.chainId,8453);assert.equal(P.deployment.value,'0');
assert(Number.isSafeInteger(P.deployment.nonce)&&P.deployment.nonce>=0);
const args=[C.safe,C.bnkr,C.staking,C.relay];
assert.equal(P.deployment.data,encodeDeployData({abi:A.abi,bytecode:A.bytecode,args}),'Creation differs from compiled adapter');
assert.equal(P.adapter.toLowerCase(),getContractAddress({from:P.deployment.from,nonce:BigInt(P.deployment.nonce)}).toLowerCase());
const zero='0x'+'0'.repeat(40);
const expected={safe:C.safe,bnkr:C.bnkr,staking:C.staking,relay:C.relay,stakingCodeHash:C.stakingCodeHash,operator:zero,paused:true,
 maxStakePerDay:0n,maxPrincipal:0n,coolingPrincipal:0n,pendingYield:0n,lastStake:0n,lastHarvest:0n,lastRelay:0n,totalStaked:0n,totalYieldClaimed:0n,totalYieldRelayed:0n};
const calls=Object.entries(expected).map(([name,result])=>({name,data:encodeFunctionData({abi:A.abi,functionName:name}),expected:encodeFunctionResult({abi:A.abi,functionName:name,result})}));
const payload={sourceCommit,plan:{chainId:8453,safe:C.safe,deployer:P.deployment.from,firstNonce:P.deployment.nonce,
 addresses:{adapter:P.adapter},deployments:[{...P.deployment,name:'StakedBankrStakingAdapter',address:P.adapter,args}]},
 verification:[{code:A.deployedBytecode,immutableSlots:Object.values(A.immutableReferences).flat(),calls}],
 gasOracle:'0x420000000000000000000000000000000000000f',l1FeeSelector:'0xf1c7a58b'};
const dir='bnkr-deployment';mkdirSync(dir,{recursive:true});
const bytes=JSON.stringify(payload,null,2)+'\n';writeFileSync(dir+'/payload.json',bytes);
writeFileSync(dir+'/payload-digest.mjs',`export const payloadSha256 = '${createHash('sha256').update(bytes).digest('hex')}';\n`);
for(const f of ['engine.mjs','style.css'])copyFileSync('deployment/'+f,dir+'/'+f);
let app=readFileSync('deployment/app.mjs','utf8');
app=app.replace('i<4','i<payload.plan.deployments.length')
 .replace("['Reward relay','Automation guard','Bounded buyback executor','Fee collector']","['BNKR staking adapter']")
 .replace('All four helpers are deployed and verified. The guard remains paused and unconfigured. Download receipts and return them for verification before any Safe migration.','The adapter is deployed and verified, paused with zero operator and limits. Download its receipt for verification before scheduling Safe changes.')
 .replaceAll('staked-deployment:','staked-bnkr-deployment:')
 .replace('Staked-Base-Deployment-Receipts.json','Staked-BNKR-Deployment-Receipt.json');
writeFileSync(dir+'/app.mjs',app);
let html=readFileSync('deployment/index.html','utf8');
html=html.replace('STAKED · Deploy inactive helpers','STAKED · BNKR staking deployment')
 .replace('Deploy the four helpers.','Deploy the BNKR staking adapter.')
 .replace('Approve one contract creation at a time in Rabby. Your Safe controls the new contracts. The trading guard starts paused.','After review, approve one contract creation in Rabby. Your Safe controls the adapter. It starts paused with no operator or spending limits.')
 .replace('Independent review is still outstanding.','This is a review candidate. Confirm the reviewed revision before approving deployment.')
 .replace('These four transactions send','This transaction sends')
 .replace('Use this wallet only for these deployments until all four finish.','If this wallet’s nonce changes, regenerate the deployment package.')
 .replace('<a href="../">STAKED</a>','<a href="https://stakedvault.app">STAKED</a>');
writeFileSync(dir+'/index.html',html);
console.log('Prepared bnkr-deployment: one paused adapter, no live transaction sent.');
