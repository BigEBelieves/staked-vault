import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { createDeploymentPlan, prepareSafeBatch, verifyDeployments, json } from './deployment-plan.mjs';

const usage = `Usage (all commands are read-only):
  npm run prepare:deployment -- plan DEPLOYER OUTPUT.json
  npm run prepare:deployment -- verify PLAN.json RECEIPT-HASHES.json
  npm run prepare:deployment -- batch wire|fees|operator|rollback PLAN.json RECEIPT-HASHES.json OUTPUT.json
Set BASE_READ_RPC_URL. Hashes file: four transaction hashes in plan order.
Only direct CREATE deployments from an ordinary EOA are supported; no Safe/factory/AA deployment.`;
const load = path => JSON.parse(readFileSync(path,'utf8'));
const save = (path,value) => writeFileSync(path,json(value),{flag:'wx'});
async function main() {
  const [command,...args] = process.argv.slice(2);
  if (!['plan','verify','batch'].includes(command)) throw new Error(usage);
  if (!process.env.BASE_READ_RPC_URL) throw new Error('BASE_READ_RPC_URL is required');
  const C = load('config/base.json'), A = load('build/all.json');
  const client = createPublicClient({chain:base,transport:http(process.env.BASE_READ_RPC_URL,{retryCount:0}),cacheTime:0});
  if (await client.getChainId() !== 8453) throw new Error('Wrong chain: Base 8453 required');
  if (command === 'plan') {
    if (args.length!==2) throw new Error(usage);
    const [deployer,out] = args;
    const code = await client.getBytecode({address:deployer});
    if (code && code!=='0x') throw new Error('Use an ordinary EOA, not a Safe, delegated EIP-7702 account or factory');
    if ([C.safe,C.bankr].includes(deployer.toLowerCase())) throw new Error('Use a separate deployment EOA');
    const nonce = await client.getTransactionCount({address:deployer,blockTag:'pending'});
    if (nonce!==await client.getTransactionCount({address:deployer,blockTag:'latest'})) throw new Error('Deployer has pending transactions');
    const plan = createDeploymentPlan(C,A,deployer,nonce);
    for (const address of Object.values(plan.addresses)) {
      const existing = await client.getBytecode({address});
      if (existing && existing!=='0x') throw new Error('Predicted address already has code');
    }
    save(out,plan);
    console.log(`Saved ${out}. Four unsigned creations. Review source, nonce and gas before signing; nothing sent.`);
  } else if (command === 'verify') {
    if (args.length!==2) throw new Error(usage);
    const result = await verifyDeployments(client,C,A,load(args[0]),load(args[1]));
    console.log(json({block:result.block.number,blockHash:result.block.hash,deployments:result.receipts}));
  } else {
    if (args.length!==4) throw new Error(usage);
    const [stage,planPath,hashesPath,out] = args;
    const result = await prepareSafeBatch(client,C,A,load(planPath),load(hashesPath),stage);
    save(out+'.verification.json',result.verification);
    save(out,result.batch);
    console.log(`Saved ${out} and verification report. Regenerate near execution, review in Safe and simulate before signing. Nothing sent.`);
  }
}
main().catch(error => { console.error(error.shortMessage ?? error.message); process.exitCode=1; });
