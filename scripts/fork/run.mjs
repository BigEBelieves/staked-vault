import { spawn } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const executable = process.env.ANVIL_BIN ?? 'anvil';
const upstream = process.env.BASE_READ_RPC_URL ?? 'https://mainnet.base.org';
const twap = process.argv.includes('--twap');
const migration = process.argv.includes('--v3-migration');
const planOnly = process.argv.includes('--v3-plan');
const block = process.env.BASE_FORK_BLOCK ?? (twap ? '51948371' : '51929714');
if (migration && !process.env.BASE_FORK_BLOCK) throw new Error('V3 migration requires an explicit freshly checked BASE_FORK_BLOCK');
const upstreamPort = 18554, forkPort = 18545;
const logPrefix = `/tmp/staked-${migration?'v3-migration':planOnly?'v3-plan':twap?'twap':'base'}-${process.pid}`;
const upstreamLog = logPrefix+'-upstream.log', anvilLog=logPrefix+'-anvil.log';
const processes = [];
function start(cmd, args, log, localOnly = false) {
  const env = localOnly ? {...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost'} : process.env;
  const child = spawn(cmd, args, { env, stdio: log ? ['ignore', openSync(log, 'w'), openSync(log, 'a')] : 'inherit' });
  child.on('error', error => console.error(error.message));
  processes.push(child);
  return child;
}
async function ready(url, method, attempts = 240) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params: []}), signal: AbortSignal.timeout(1000)});
      const json = await r.json();
      if ('result' in json) return json.result;
    } catch {}
    await setTimeout(250);
  }
  throw new Error(`Local fork startup failed: ${method}`);
}
try {
  console.log(planOnly ? 'Starting read-only V3 preparation; no fork or live writes' : `Starting local-only Base fork at block ${block}`);
  start('python', ['scripts/fork/read-only-rpc.py', '--url', upstream, '--port', String(upstreamPort)], upstreamLog);
  await ready(`http://127.0.0.1:${upstreamPort}`, 'eth_chainId');
  if (planOnly) {
    const index=process.argv.indexOf('--v3-plan');
    const child=spawn(process.execPath,['scripts/prepare-v3-migration.mjs',...process.argv.slice(index+1)],{stdio:'inherit',env:{...process.env,BASE_READ_RPC_URL:`http://127.0.0.1:${upstreamPort}`}});
    processes.push(child);
    const code=await new Promise(resolve=>child.on('exit',resolve));
    if(code!==0)throw new Error(`Read-only preparation exited ${code}`);
  } else {
  start(executable, ['--fork-url', `http://127.0.0.1:${upstreamPort}`, '--fork-block-number', block,
    '--chain-id', '8453', '--network', 'optimism', '--accounts', '2', '--host', '127.0.0.1', '--port', String(forkPort),
    ...(migration ? ['--no-mining','--gas-price','1000000000','--timeout','180000'] : []), '--silent'], anvilLog, true);
  const url = `http://127.0.0.1:${forkPort}`;
  console.log('Local client:', await ready(url, 'web3_clientVersion'));
  console.log('Node info:', JSON.stringify(await ready(url, 'anvil_nodeInfo')));
  if (!process.argv.includes('--smoke')) {
    const child = spawn(process.execPath, [migration ? 'test/v3-migration-fork.test.mjs' : twap ? 'test/twap-fork.test.mjs' : 'test/base-fork.test.mjs'], {stdio: 'inherit', env: {...process.env, LOCAL_FORK_RPC_URL: url, UPSTREAM_READ_RPC_URL:`http://127.0.0.1:${upstreamPort}`, BASE_FORK_BLOCK: block}});
    processes.push(child);
    const code = await new Promise(resolve => child.on('exit', resolve));
    if (code !== 0) throw new Error(`Fork test exited ${code}`);
  }
  }
} catch (error) {
  console.error(error.message);
  for (const file of [upstreamLog, anvilLog]) {
    try { console.error(readFileSync(file, 'utf8').slice(-3000)); } catch {}
  }
  process.exitCode = 1;
} finally {
  for (const child of processes.reverse()) if (child.exitCode === null) child.kill('SIGTERM');
}
