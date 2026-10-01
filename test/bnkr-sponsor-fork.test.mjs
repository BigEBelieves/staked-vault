import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http,parseAbi,encodeDeployData,encodeFunctionData,toHex,keccak256} from 'viem';
import {base} from 'viem/chains';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const endpoint=process.env.LOCAL_FORK_RPC_URL??'http://127.0.0.1:19545';
assert(['127.0.0.1','localhost'].includes(new URL(endpoint).hostname),'LOCAL ONLY');
const transport=http(endpoint,{timeout:600000,retryCount:0});
const p=createPublicClient({chain:base,transport,cacheTime:0,pollingInterval:100});const w=createWalletClient({chain:base,transport});
assert.match(await p.request({method:'web3_clientVersion'}),/^anvil\//);
const node=await p.request({method:'anvil_nodeInfo'});assert.equal(BigInt(node.forkConfig.forkBlockNumber),BigInt(process.env.BASE_FORK_BLOCK??52009577));
const A=JSON.parse(readFileSync('build/all.json'));
const safe='0xb9066550918fa778a4039120eac878230cf8f6FC',bankr='0x88470240FF0663Faefa68B1D7621b472DdD9584A',bnkr='0x22af33fe49fd1fa80c7149773dde5890d3c76f3b',relay='0xf9421C19ff9e6a09b30BdF9183739A232C3F33bF',vault='0x6E6c236D5EF18cAF835fAf2bD495ED48e3F8CCc5',dist='0x5E22cC89dA97c5C07F19AE332be62f9Ed41B68d5';
const [actor,operator,outsider]=await p.request({method:'eth_accounts'});
await p.request({method:'anvil_impersonateAccount',params:[safe]});await p.request({method:'anvil_setBalance',params:[safe,toHex(10n**20n)]});
const erc=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function transfer(address,uint256) returns(bool)','function approve(address,uint256) returns(bool)']);
const bAbi=A.BankrStakingV3.abi;const read=(address,abi,functionName,args=[])=>p.readContract({address,abi,functionName,args});
const bal=a=>read(bnkr,erc,'balanceOf',[a]);
let checks=0;const check=(v,m)=>{assert(v,m);console.log('ok',m);checks++;};
async function receiptFor(hash){ await p.request({method:'evm_mine',params:[]});return p.waitForTransactionReceipt({hash}); }
async function tx(to,abi,fn,args=[],account=safe){const hash=await w.sendTransaction({account,to,data:encodeFunctionData({abi,functionName:fn,args}),value:0n,gas:6000000n});const r=await receiptFor(hash);assert.equal(r.status,'success',fn);return r;}
async function warp(sec){await p.request({method:'evm_increaseTime',params:[sec]});await p.request({method:'evm_mine',params:[]});}
const code=await p.getBytecode({address:bankr});check(keccak256(code)==='0xd5aed805076ee0ed5e564daf83ae17fbe099347b87d443db69159571c87e21c3','real Bankr runtime hash matches verified source');
const abi=A.StakedBankrSponsor.abi;
const receipt=await receiptFor(await w.sendTransaction({account:actor,data:encodeDeployData({abi,bytecode:A.StakedBankrSponsor.bytecode,args:[safe,bnkr,bankr,relay,actor]}),gas:6000000n}));assert.equal(receipt.status,'success');const helper=receipt.contractAddress;
const min=10n**18n,policy=[operator,20n*min,40n*min];
const oldDestination=await read(dist,A.StakedDistributorV3.abi,'bnkrStakingWallet');
await tx(helper,abi,'scheduleConfiguration',[encodeFunctionData({abi,functionName:'setPolicy',args:policy})]);
await tx(relay,A.StakedRewardRelay.abi,'setYieldSource',[helper,true]);await warp(172800);
await tx(helper,abi,'setPolicy',policy);await tx(helper,abi,'setPaused',[false]);
// Local fork only: seed the simulated sponsor using existing Safe BNKR; no token storage patching.
await tx(bnkr,erc,'transfer',[actor,20n*min]);
const initial=await bal(actor);
await tx(bnkr,erc,'approve',[helper,20n*min],actor);await tx(helper,abi,'fund',[20n*min],actor);
check(await read(helper,abi,'principalOutstanding')===20n*min,'registered sponsor principal');
await tx(helper,abi,'stakePrincipal',[10n*min],operator);
check(await read(bankr,bAbi,'stakeOf',[helper])===10n*min,'real Bankr holds sponsor stake');
check(await read(bnkr,erc,'allowance',[helper,bankr])===0n,'staking approval zero');
await warp(86400);await tx(helper,abi,'harvest',[],operator);
const claimed=await read(helper,abi,'pendingYield');check(claimed>0n,'real reward harvest positive');
check(await read(helper,abi,'idlePrincipal')===10n*min,'harvest did not change principal');
const vb=await bal(vault);await tx(helper,abi,'relayYield',[],operator);
check(await bal(vault)===vb+claimed,'earned reward delivered through existing relay');
check(await read(bnkr,erc,'allowance',[helper,relay])===0n,'relay approval zero');
await assert.rejects(p.simulateContract({address:helper,abi,functionName:'beginExit',account:operator}));check(true,'operator cannot trigger permanent exit');
await tx(helper,abi,'beginExit',[],actor);
await assert.rejects(p.simulateContract({address:helper,abi,functionName:'setPaused',args:[false],account:safe}));check(true,'Safe cannot reopen sponsor exit');
// Principal exit also works if Safe disables reward forwarding.
await tx(relay,A.StakedRewardRelay.abi,'setYieldSource',[helper,false]);
await tx(helper,abi,'returnIdlePrincipal',[10n*min],actor);
await tx(helper,abi,'requestUnstake',[10n*min],actor);
await assert.rejects(p.simulateContract({address:helper,abi,functionName:'withdrawPrincipal',account:actor}));check(true,'Bankr cooldown enforced');
await warp(172800);await tx(helper,abi,'withdrawPrincipal',[],actor);
check(await bal(actor)===initial,'sponsor recovers full principal without Safe withdrawal signature');
check(await read(helper,abi,'principalOutstanding')===0n,'no outstanding principal');
check(await read(bankr,bAbi,'stakeOf',[helper])===0n,'external stake closed');
check((await read(dist,A.StakedDistributorV3.abi,'bnkrStakingWallet')).toLowerCase()===oldDestination.toLowerCase(),'fee destination unchanged');
mkdirSync('build',{recursive:true});writeFileSync('build/bnkr-sponsor-fork-report.json',JSON.stringify({mode:'LOCAL FORK ONLY',forkBlock:String(node.forkConfig.forkBlockNumber),checks,claimed:String(claimed),staking:bankr,codeHash:keccak256(code),limitations:['Historical fork, not a live execution. Safe and sponsor impersonated locally.','Safe BNKR transferred locally for test funding only. Real personal assets untouched.','Future rewards and underlying withdrawal availability are not guaranteed.']},null,2));console.log(checks,'checks passed');
