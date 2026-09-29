// Dedicated GitHub-hosted rehearsal. No keys, secrets, deployment or live writes.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {toEventSelector,toHex} from 'viem';
import {publicSummary,publicFailure} from './ci-summary.mjs';
const providers=['https://base-rpc.publicnode.com','https://mainnet.base.org'];
const C={...JSON.parse(readFileSync('config/base.json')),...JSON.parse(readFileSync('config/v3-migration.json'))};
function rpc(endpoint,method,params){
 assert(['eth_chainId','eth_getBlockByNumber','eth_call','eth_getLogs'].includes(method));
 const result=JSON.parse(execFileSync('curl',['-fsS','--connect-timeout','5','--max-time','15',endpoint,'-H','Content-Type: application/json','--data',JSON.stringify({jsonrpc:'2.0',id:1,method,params})],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 assert('result' in result&&!result.error,'RPC result required');return result.result;
}
let selected;
for(const endpoint of providers){
 try{
  assert.equal(BigInt(rpc(endpoint,'eth_chainId',[])),8453n);
  const block=rpc(endpoint,'eth_getBlockByNumber',['latest',false]);
  assert.match(block.hash,/^0x[0-9a-f]{64}$/i);assert(BigInt(block.number)>0n);
  const route=rpc(endpoint,'eth_call',[{to:C.distributor,data:'0xc31c9c07'},block.number]);
  assert.equal('0x'+route.slice(-40).toLowerCase(),C.v3Router.toLowerCase());
  const from=BigInt(C.vaultDeploymentBlock),to=from+99n;
  assert(to<=BigInt(block.number));
  assert(Array.isArray(rpc(endpoint,'eth_getLogs',[{address:C.vault,topics:[toEventSelector('Staked(address,uint256,uint256)')],fromBlock:toHex(from),toBlock:toHex(to)}])),'Historical depositor logs required');
  selected={endpoint,block};break;
 }catch{console.log('Read-provider preflight failed; no fork or writes started.');}
}
if(!selected)throw new Error('No read provider passed pinned Base state preflight.');
const {endpoint,block}=selected;
const blockNumber=BigInt(block.number).toString(),commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const out=mkdtempSync(join(tmpdir(),'staked-private-fork-')),report=join(out,'result.json');
console.log('Pinned Base block '+blockNumber+'; starting local-only rehearsal.');
const privateLog=createWriteStream(join(out,'private.log'),{flags:'wx'});
const child=spawn(process.execPath,['scripts/fork/run.mjs','--v3-migration'],{env:{...process.env,BASE_READ_RPC_URL:endpoint,BASE_FORK_BLOCK:blockNumber,V3_MIGRATION_REPORT:report,ANVIL_BIN:resolve('scripts/fork/anvil/node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil')},stdio:['ignore','pipe','pipe']});
let phase='startup',stderr='';
createInterface({input:child.stdout}).on('line',line=>{
 privateLog.write(line+'\n');
 // Only static test phase labels and assertions are printed. No raw RPC errors.
 if(/^\[migration\] [A-Za-z0-9 ,;().-]+$/.test(line)){phase=line;console.log(line);}
 else if(/^  ok [A-Za-z0-9 ,;().-]+$/.test(line))console.log(line);
});
child.stderr.on('data',bytes=>{privateLog.write(bytes);stderr=(stderr+bytes.toString()).slice(-1000000);});
const timer=setTimeout(()=>child.kill('SIGTERM'),25*60*1000);
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});clearTimeout(timer);privateLog.end();
if(code!==0){console.error('Rehearsal failed during '+phase+'. No success claimed; raw private logs were not published.');console.error(JSON.stringify(publicFailure(stderr)));process.exit(1);}
let summary;
try{summary=publicSummary(JSON.parse(readFileSync(report,'utf8')),blockNumber,block.hash,commit);}
catch{console.error('Fork report failed verification. No success claimed and no private report values published.');process.exit(1);}
writeFileSync(join(out,'public-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
if(process.env.GITHUB_STEP_SUMMARY)writeFileSync(process.env.GITHUB_STEP_SUMMARY,'## V3 Base-fork rehearsal passed\n\n```json\n'+JSON.stringify(summary,null,2)+'\n```\n',{flag:'a'});
