import {readFileSync} from 'node:fs';
import {createPublicClient, http} from 'viem';
import {base} from 'viem/chains';
import {json} from './deployment-plan.mjs';
import {prepareTrialPolicy, readTrialReadiness} from './trial-policy.mjs';

const load = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
try {
  const url = process.env.BASE_READ_RPC_URL ?? process.env.PRIVATE_BASE_RPC_URL;
  if (!url) throw new Error('Set BASE_READ_RPC_URL for read-only preparation; this does not verify private submission');
  const client = createPublicClient({chain:base,transport:http(url,{retryCount:0}),cacheTime:0});
  const options = {config:load('../config/base.json'),artifacts:load('../build/all.json'),helpers:load('../deployment/payload.json').plan.addresses};
  if (!process.argv[2]) console.log(json(await readTrialReadiness(client, options)));
  else {
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    console.log(json(await prepareTrialPolicy(client, {...options,policy:input.policy,validForSeconds:input.validForSeconds ?? 1800})));
  }
} catch (error) {
  // Never echo nested provider errors, credential-bearing URLs or the input file's contents.
  console.error(error.name === 'AssertionError' || error.constructor === Error ? error.message.split('\n')[0] : 'Read-only preparation failed; check RPC configuration and input locally');
  process.exitCode = 1;
}
