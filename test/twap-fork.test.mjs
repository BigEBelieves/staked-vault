// Local Anvil only. No private keys and no RPC broadcast to Base.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData,
  encodePacked, concatHex, padHex, toHex, parseEventLogs } from 'viem';
import { base } from 'viem/chains';
import { prepareTwapKeeper, revalidateTwapKeeper } from '../scripts/twap-keeper-plan.mjs';
import {createTwapDeployment,verifyTwapDeployment,prepareTwapActivation} from '../scripts/twap-deployment.mjs';

const url = new URL(process.env.LOCAL_FORK_RPC_URL ?? 'http://127.0.0.1:18545');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Fork test refuses non-loopback RPC');
// Cold archive-storage reads can be slow; this timeout applies only to loopback Anvil.
const rpc = http(url.href, {timeout: 600000, retryCount: 0});
const pc = createPublicClient({chain: base, transport: rpc, cacheTime: 0, pollingInterval: 50});
const wc = createWalletClient({chain: base, transport: rpc});
const clientVersion = await pc.request({method: 'web3_clientVersion'});
assert.match(clientVersion, /^anvil\//);
const node = await pc.request({method: 'anvil_nodeInfo'});
const forkBlock = Number(process.env.BASE_FORK_BLOCK ?? 51948371);
assert.equal(node.forkConfig?.forkBlockNumber, forkBlock);
assert.equal(await pc.getChainId(), 8453);
assert.equal(Number(await pc.getBlockNumber()), forkBlock, 'Run on a fresh fork');
const originalBlock = await pc.getBlock({blockNumber: BigInt(forkBlock)});
await pc.request({method:'anvil_setBlockTimestampInterval',params:[2]});
const C = JSON.parse(readFileSync('config/base.json'));
const A = JSON.parse(readFileSync('build/all.json'));
const ZERO = '0x' + '0'.repeat(40);
const DEAD = '0x000000000000000000000000000000000000dead';
const E18 = 10n ** 18n;
const [actor, outsider] = await pc.request({method: 'eth_accounts'});
let checks = 0;
const observations = {};
function check(value, message) { assert(value, message); checks++; console.log(`  ok ${message}`); }
const report = {block: forkBlock, blockHash: originalBlock.hash, timestamp: originalBlock.timestamp.toString(),
  anvil: clientVersion, hardfork: node.hardFork, network: 'optimism', mode: 'local fork only',
  limitations: ['Signer approval hashes are impersonated on the local fork; no real wallet signatures.',
    'Initial ETH balances are increased locally for gas.',
    'Test limits are fixtures, not an activation approval.',
    'BNKR is purchased with locally funded ETH and donated to the real collector to exercise forwarding.',
    'Local blocks advance by two seconds per transaction; fork RPC latency is not production quote latency.',
    'Private RPC submission and future liquidity conditions are not tested.'], observations};
const abi = name => A[name].abi;
const tokenAbi = parseAbi(['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)', 'function transfer(address,uint256) returns(bool)']);
const safeAbi = parseAbi(['function getOwners() view returns(address[])', 'function getThreshold() view returns(uint256)',
  'function nonce() view returns(uint256)', 'function approveHash(bytes32)',
  'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)',
  'function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns(bool)',
  'event ExecutionSuccess(bytes32 indexed txHash,uint256 payment)']);
const feeAbi = parseAbi(['function getShares(bytes32,address) view returns(uint256)', 'function collectFees(bytes32) returns(uint128,uint128)',
  'function updateBeneficiary(bytes32,address)']);
const read = (address, contractAbi, functionName, args = []) => pc.readContract({address, abi: contractAbi, functionName, args});
const call = (name, address, fn, args = []) => read(address, abi(name), fn, args);
const balance = (token, who) => read(token, tokenAbi, 'balanceOf', [who]);
const allow = (token, who, spender) => read(token, tokenAbi, 'allowance', [who, spender]);
function tx(address, contractAbi, functionName, args = []) {
  return {to: address, data: encodeFunctionData({abi: contractAbi, functionName, args})};
}
async function send(request, account = actor) {
  const hash = await wc.sendTransaction({value: 0n, ...request, account, gas: 12000000n});
  const receipt = await pc.waitForTransactionReceipt({hash});
  if (receipt.status !== 'success') {
    const trace = await pc.request({method: 'debug_traceTransaction', params: [hash, {tracer: 'callTracer'}]});
    console.error(JSON.stringify(trace, null, 2));
    throw new Error(`Local transaction reverted: ${hash}`);
  }
  return receipt;
}
async function write(address, contractAbi, fn, args = [], from = actor) { return send(tx(address, contractAbi, fn, args), from); }
async function impersonate(address) {
  await pc.request({method: 'anvil_impersonateAccount', params: [address]});
  await pc.request({method: 'anvil_setBalance', params: [address, toHex(100n * E18)]});
}
const owners = (await read(C.safe, safeAbi, 'getOwners')).sort((a,b) => a.toLowerCase().localeCompare(b.toLowerCase()));
check(owners.length === 3 && await read(C.safe, safeAbi, 'getThreshold') === 2n, 'real Safe has three owners and threshold two');
for (const who of [owners[0], owners[1], C.bankr]) await impersonate(who);
const multiSendAbi = parseAbi(['function multiSend(bytes transactions) payable']);
// Both approvals and the Safe's actual signature-validation/execTransaction path are exercised.
async function safeBatch(actions, label = 'Safe batch') {
  const packed = concatHex(actions.map(a => encodePacked(['uint8','address','uint256','uint256','bytes'],
    [0, a.to, 0n, BigInt((a.data.length - 2) / 2), a.data])));
  const data = encodeFunctionData({abi: multiSendAbi, functionName: 'multiSend', args: [packed]});
  const fields = [C.multiSendCallOnly, 0n, data, 1, 0n, 0n, 0n, ZERO, ZERO];
  const nonce = await read(C.safe, safeAbi, 'nonce');
  const hash = await read(C.safe, safeAbi, 'getTransactionHash', [...fields, nonce]);
  for (const owner of owners.slice(0,2)) await write(C.safe, safeAbi, 'approveHash', [hash], owner);
  const signatures = concatHex(owners.slice(0,2).map(owner => concatHex([padHex(owner, {size:32}), toHex(0n, {size:32}), '0x01'])));
  const receipt = await write(C.safe, safeAbi, 'execTransaction', [...fields, signatures]);
  check(parseEventLogs({abi: safeAbi, logs: receipt.logs, eventName: 'ExecutionSuccess'}).length === 1, label);
  return receipt;
}

console.log('[twap fork] deployed custody and authority');
const relay = await call('StakedDistributor',C.distributor,'vault');
const oldGuard = await call('StakedDistributor',C.distributor,'keeper');
const collector = JSON.parse(readFileSync('deployment/payload.json')).plan.addresses.collector;
const factory = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
check((await call('StakedDistributor',C.distributor,'owner')).toLowerCase()===C.safe,'Safe owns distributor');
check((await call('StakedVault',C.vault,'distributor')).toLowerCase()===relay.toLowerCase(),'existing relay is connected');
check(await call('StakedAutomationGuard',oldGuard,'paused'),'old guard is paused');
check(await read(C.initializer,feeAbi,'getShares',[C.poolId,collector])===950000000000000000n,'collector already owns fee rights');
const extended={...C,relay,collector,oldGuard,factory};
const deployment=createTwapDeployment(extended,A,actor,await pc.getTransactionCount({address:actor}));
const receipt=await send({data:deployment.deployments[0].data});
await pc.request({method:'evm_mine',params:[]});
await verifyTwapDeployment(pc,extended,A,deployment,receipt.transactionHash);
check(true,'generated creation bytes, receipt, runtime and immutables verify');
await assert.rejects(verifyTwapDeployment(pc,extended,A,{...deployment,firstNonce:'0'},receipt.transactionHash),/Plan differs/);
check(true,'altered deployment plan rejected');
const keeper=receipt.contractAddress;
check(await call('StakedTwapKeeper',keeper,'paused'),'new keeper starts paused');
check((await call('StakedTwapKeeper',keeper,'safe')).toLowerCase()===C.safe,'immutable authority is Safe');
const limits={maxBnkrPerSwap:120000n*E18,maxBnkrPer24Hours:240000n*E18,minLiquidityBnkrWeth:10n**24n,
 minLiquidityWethUsdc:6n*10n**17n,minInterval:3600,slippageBps:50,maxTickDeviation:100,maxInputReserveBps:10};
const activation=await prepareTwapActivation(pc,extended,A,deployment,receipt.transactionHash,limits);
await safeBatch(activation.batch.transactions,'generated activation executes through real 2-of-3 Safe');
check(await call('StakedAutomationGuard',oldGuard,'operator')===ZERO,'old operator authority removed');
await assert.rejects(prepareTwapActivation(pc,extended,A,deployment,receipt.transactionHash,limits),/Existing keeper changed/);
check(true,'already executed activation cannot be prepared twice');
check((await call('StakedVault',C.vault,'keeper')).toLowerCase()===oldGuard.toLowerCase() && await call('StakedAutomationGuard',oldGuard,'paused'),'buybacks stay paused');
const options={keeper,operator:C.bankr,safe:C.safe,distributor:C.distributor,v3Quoter:C.v3Quoter,slippageBps:50};
await assert.rejects(prepareTwapKeeper(pc,options),/below threshold/);check(true,'dust queue waits automatically');
async function deny(request,from,reason,message) {
 await assert.rejects(pc.call({...request,account:from}),error=>String(error).includes(reason));check(true,message);
}
await deny(tx(C.distributor,abi('StakedDistributor'),'swapAndNotify',[1n]),C.bankr,'not keeper','Bankr cannot call legacy swap directly');
await deny(tx(keeper,abi('StakedTwapKeeper'),'setLimits',[limits]),C.bankr,'not Safe','Bankr cannot relax limits');
console.log('[twap fork] real collection, oracle and swaps');
const q3Abi=parseAbi(['function quoteExactInput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)']);
const buyPath=encodePacked(['address','uint24','address'],[C.weth,10000,C.bnkr]);
const buyAmount=E18/10n;
await send({...tx(C.weth,parseAbi(['function deposit() payable']),'deposit'),value:buyAmount});
const buyQuote=(await pc.simulateContract({address:C.v3Quoter,abi:q3Abi,functionName:'quoteExactInput',args:[buyPath,buyAmount]})).result[0];
await write(C.weth,tokenAbi,'approve',[C.v3Router,buyAmount]);
await write(C.v3Router,abi('ISwapRouter02'),'exactInput',[{path:buyPath,recipient:actor,amountIn:buyAmount,amountOutMinimum:buyQuote*995n/1000n}]);
const minBatch=await call('StakedDistributor',C.distributor,'minBnkrBatch');
const donation=minBatch*2n;
check(await balance(C.bnkr,actor)>=donation,'fixture can fund unchanged production batch threshold');
const bankrBefore=[await balance(C.bnkr,C.bankr),await balance(C.usdc,C.bankr)];
const safeBefore=await balance(C.bnkr,C.safe);
await write(C.bnkr,tokenAbi,'transfer',[collector,donation]);
await write(collector,abi('StakedFeeCollector'),'collectAndDistribute',[],C.bankr);
check(await balance(C.bnkr,C.safe)===safeBefore+donation/2n,'collector forwards existing BNKR split to Safe');
check(await allow(C.bnkr,collector,C.distributor)===0n,'collector allowance cleared');
const queue=await call('StakedDistributor',C.distributor,'pendingSwapBnkr');
const floor=await call('StakedTwapKeeper',keeper,'minimumUsdc',[queue]);
check(floor>0n,'both canonical pools produce usable on-chain floor');
const nonce=await call('StakedTwapKeeper',keeper,'nonce');
const head=await pc.getBlock();
await deny(tx(keeper,abi('StakedTwapKeeper'),'swapAndNotify',[queue,1n,Number(head.timestamp+60n),nonce]),C.bankr,'below TWAP floor','trivial minimum rejected by deployed-price history');
const plan=await prepareTwapKeeper(pc,options);
await revalidateTwapKeeper(pc,plan,options);
const before=await balance(C.usdc,C.vault);
await send({to:plan.to,data:plan.data},C.bankr);
const delivered=await balance(C.usdc,C.vault)-before;
check(delivered>=plan.quotes.minimumUsdc,'actual BNKR-WETH-USDC swap reaches original vault above floor');
check(await call('StakedDistributor',C.distributor,'pendingSwapBnkr')===0n,'queue consumed');
check(await call('StakedTwapKeeper',keeper,'spentLast24Hours')===queue,'exact rolling spend recorded');
check(await balance(C.bnkr,C.bankr)===bankrBefore[0] && await balance(C.usdc,C.bankr)===bankrBefore[1],'Bankr receives no BNKR or USDC');
for(const [token,a,b] of [[C.bnkr,C.distributor,C.v3Router],[C.usdc,C.distributor,relay],[C.usdc,relay,C.vault]])
 check(await allow(token,a,b)===0n,'swap/reward allowance cleared');
await deny({to:plan.to,data:plan.data},C.bankr,'stale nonce','replay rejected');
await safeBatch([tx(keeper,abi('StakedTwapKeeper'),'setPaused',[true]),tx(C.distributor,abi('StakedDistributor'),'setKeeper',[oldGuard])],'Safe can pause and replace keeper later');
check((await call('StakedDistributor',C.distributor,'keeper')).toLowerCase()===oldGuard.toLowerCase(),'Safe replacement restores paused keeper');
report.checks=checks;
report.observations={distribution:{bnkrIn:queue.toString(),minimumUsdc:floor.toString(),usdcOut:delivered.toString()}};
writeFileSync(process.env.TWAP_FORK_REPORT ?? '/tmp/staked-twap-fork.json',JSON.stringify(report,null,2)+'\n');
console.log(`${checks} TWAP Base fork checks passed; no live transactions sent.`);
