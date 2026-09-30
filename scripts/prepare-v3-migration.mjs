// This CLI prepares files only; it cannot send or sign a transaction.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createPublicClient,http,getAddress} from 'viem';
import {base} from 'viem/chains';
import {createV3Plan,snapshotMigration,limitsObject,verifyV3Deployments,prepareV3Stage,serialize} from './v3-migration.mjs';
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const save=(p,v)=>writeFileSync(p,serialize(v),{flag:'wx'});
const C={...load('config/base.json'),...load('config/v3-migration.json'),logPageSize:process.env.BASE_LOG_PAGE_SIZE??2000},A=load('build/all.json');
const [command,...args]=process.argv.slice(2);
const usage='Read-only: plan DEPLOYER OUTPUT_DIRECTORY | verify PLAN HASHES | stage cutover|rollback PLAN HASHES OUTPUT.json';
async function main(){
 if(!process.env.BASE_READ_RPC_URL)throw new Error('BASE_READ_RPC_URL required');
 const client=createPublicClient({chain:base,transport:http(process.env.BASE_READ_RPC_URL,{timeout:600000,retryCount:0}),cacheTime:0});
 if(command==='plan'){
  if(args.length!==2)throw new Error(usage);const [raw,out]=args,deployer=getAddress(raw);
  const snapshot=await snapshotMigration(client,C,A,process.env.V3_SNAPSHOT_BLOCK);
  const code=await client.getBytecode({address:deployer});if(code&&code!=='0x')throw new Error('Ordinary undelegated EOA required');
  const nonce=await client.getTransactionCount({address:deployer,blockTag:'pending'});
  if(nonce!==await client.getTransactionCount({address:deployer,blockTag:'latest'}))throw new Error('Deployer has pending transactions');
  const plan=createV3Plan(C,A,deployer,nonce,snapshot.distributor.minBnkrBatch,limitsObject(snapshot.keeper.limits));
  for(const address of Object.values(plan.addresses)){const code=await client.getBytecode({address});if(code&&code!=='0x')throw new Error('Predicted address already occupied');}
  const preparedAt=await client.getBlock({blockTag:'latest'});
  if(nonce!==await client.getTransactionCount({address:deployer,blockTag:'pending'})||nonce!==await client.getTransactionCount({address:deployer,blockTag:'latest'}))throw new Error('Deployer nonce changed during preparation; regenerate');
  mkdirSync(out,{recursive:true});save(out+'/deployment-plan.json',plan);save(out+'/base-snapshot.json',snapshot);
  save(out+'/preparation-state.json',{accountingBlock:snapshot.block,accountingBlockHash:snapshot.blockHash,nonceCheckedNearBlock:preparedAt.number,nonceCheckedNearBlockHash:preparedAt.hash,deployer,firstNonce:nonce,liveTransactionSent:false});
  save(out+'/stage-preview.json',{format:'REVIEW ONLY — not a Safe import',note:'Deployments are not live. Actual stage files require verified receipt hashes and fresh state.',
   initialWiring:'All three initial connections are constructor arguments; no initial configuration transaction or 48-hour setup wait.',
   futureConfigurationDelaySeconds:172800,
   cutover:['Verify constructor wiring, an opted-in V3 stake and unchanged limits','Pause/remove old operator','Collect old fees','Return old beneficiary to Safe','Transfer 95% share to new collector','Set reviewed new limits/operator; unpause distribution'],
   rollback:['Pause/remove new operator','Return beneficiary and collector-held tokens to Safe','Restore old collector share; keep old trading paused'],
   exclusions:['No personal holdings transfers','No automatic withdrawals or restakes','Old claims, reserve and BNKR queue remain backed in old contracts','No BNKR staking-program action','No buyback activation','External Bankr job is unchanged until separately repinned']});
  console.log(`Prepared ${out}: five unsigned creations plus snapshot and stage preview. Nothing sent.`);
 }else if(command==='verify'){
  if(args.length!==2)throw new Error(usage);const v=await verifyV3Deployments(client,C,A,load(args[0]),load(args[1]));console.log(serialize({verifiedAt:v.block.number,hash:v.block.hash}));
 }else if(command==='stage'){
  if(args.length!==4)throw new Error(usage);const [stage,plan,hashes,out]=args,v=await prepareV3Stage(client,C,A,load(plan),load(hashes),stage);
  save(out+'.verification.json',v.verification);save(out,v.batch);console.log('Prepared '+out+'. Full Safe simulation and fresh review still required. Nothing sent.');
 }else throw new Error(usage);
}
main().catch(e=>{console.error(e.shortMessage??e.message);if(e.details)console.error(e.details);process.exitCode=1;});
