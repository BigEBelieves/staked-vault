import {readFileSync} from 'node:fs';
import {createV3Plan} from '../scripts/v3-migration.mjs';
import {authenticateV3Plan} from '../v3-deployment/validate.mjs';
import {DeploymentSession,hex} from '../deployment/engine.mjs';
export const build=JSON.parse(readFileSync('v3-deployment/build.json'));
const A=JSON.parse(readFileSync('build/all.json'));
export const plan=createV3Plan(build.config,A,'0xa741dAd09fFF5de643283142eD339b9F0b52b146',206,build.minimum,build.reviewedLimits);
const payload=authenticateV3Plan(plan,build);
const blockHash='0x'+'a'.repeat(64),other='0x'+'b'.repeat(40);
export function fixture(count=5){
 const p=structuredClone(payload),calls=[],values=new Map();
 p.plan.deployments=p.plan.deployments.slice(0,count);p.verification=p.verification.slice(0,count);
 const state={chain:'0x2105',account:p.plan.deployer,nonce:BigInt(p.plan.firstNonce),pending:null,balance:10n**18n,
  delegation:'0x',head:102n,txs:new Map(),receipts:new Map(),codes:new Map(),calls,sendError:null,revertSimulation:false,badRuntime:false,badGetter:false};
 const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const provider={async request({method,params=[]}){
  calls.push({method,params});
  const [arg]=params;
  if(method==='eth_chainId')return state.chain;
  if(['eth_accounts','eth_requestAccounts'].includes(method))return[state.account];
  if(method==='eth_getCode')return arg.toLowerCase()===p.plan.deployer.toLowerCase()?state.delegation:(state.codes.get(arg.toLowerCase())??'0x');
  if(method==='eth_getTransactionCount')return hex(params[1]==='pending'?(state.pending??state.nonce):state.nonce);
  if(method==='eth_getBlockByNumber')return{number:arg==='latest'?hex(state.head):arg,hash:blockHash};
  if(method==='eth_getTransactionReceipt')return state.receipts.get(arg)??null;
  if(method==='eth_getTransactionByHash')return state.txs.get(arg)??null;
  if(method==='eth_getBalance')return hex(state.balance);
  if(method==='eth_estimateGas')return hex(1000000);
  if(method==='eth_gasPrice')return hex(6000000);
  if(method==='eth_maxPriorityFeePerGas')return hex(1000000);
  if(method==='eth_call'){
   if(!arg.to){if(state.revertSimulation)throw new Error('constructor reverted');const i=p.plan.deployments.findIndex(d=>d.data===arg.data);return state.badRuntime?'0x00':p.verification[i].code;}
   if(arg.to===p.gasOracle)return hex(100000000000);
   const i=p.plan.deployments.findIndex(d=>d.address.toLowerCase()===arg.to.toLowerCase());
   if(state.badGetter)return '0x'+'0'.repeat(64);
   return p.verification[i].calls.find(c=>c.data===arg.data).expected;
  }
  if(method==='eth_sendTransaction'){
   if(state.sendError)throw state.sendError;
   const i=p.plan.deployments.findIndex(d=>d.nonce===Number(BigInt(arg.nonce)));
   const hash='0x'+String(i+1).padStart(64,'0'),d=p.plan.deployments[i];state.nonce++;
   state.txs.set(hash,{...arg,to:null,input:arg.data});
   state.receipts.set(hash,{status:'0x1',contractAddress:d.address,blockNumber:'0x65',blockHash});
   state.codes.set(d.address.toLowerCase(),p.verification[i].code);return hash;
  }
  throw new Error('Unexpected method: '+method);
 }};
 return {session:new DeploymentSession(provider,p,storage,'test',5),state,storage,provider,p};
}
