// Local Anvil only. No private keys and no RPC broadcast to Base.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData,
  encodePacked, concatHex, padHex, toHex, parseEventLogs, keccak256 } from 'viem';
import { base } from 'viem/chains';
import { prepareKeeper } from '../scripts/keeper-plan.mjs';
import { createDeploymentPlan, prepareSafeBatch, verifyDeployments } from '../scripts/deployment-plan.mjs';

const url = new URL(process.env.LOCAL_FORK_RPC_URL ?? 'http://127.0.0.1:18545');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Fork test refuses non-loopback RPC');
const rpc = http(url.href, {timeout: 180000, retryCount: 0});
const pc = createPublicClient({chain: base, transport: rpc, cacheTime: 0, pollingInterval: 50});
const wc = createWalletClient({chain: base, transport: rpc});
const clientVersion = await pc.request({method: 'web3_clientVersion'});
assert.match(clientVersion, /^anvil\//);
const node = await pc.request({method: 'anvil_nodeInfo'});
const forkBlock = Number(process.env.BASE_FORK_BLOCK ?? 51929714);
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
    'Trial policy references use local spot quotes for integration testing only, not approved production prices.',
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
  const hash = await wc.sendTransaction({...request, value: 0n, account, gas: 12000000n});
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
async function deploy(d) {
  const hash = await wc.sendTransaction({data:d.data,nonce:d.nonce,value:0n,account:actor,gas:12000000n});
  const receipt = await pc.waitForTransactionReceipt({hash});
  assert.equal(receipt.status, 'success', `${d.name} deploy`);
  assert.equal(receipt.contractAddress.toLowerCase(),d.address.toLowerCase());
  console.log(`  local helper deployed: ${d.name}`);
  return hash;
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
console.log('[fork] existing state');
for (const [name, address] of [['StakedVault', C.vault], ['StakedDistributor', C.distributor], ['StakedBuybackExecutor', C.legacyExecutor]]) {
  check((await call(name,address,'owner')).toLowerCase() === C.safe, `${name} owner is Safe`);
  check(await call(name,address,'pendingOwner') === ZERO, `${name} no pending owner`);
}
for (const [name,address] of [['StakedVault',C.vault],['StakedDistributor',C.distributor]])
  check(await call(name,address,'keeper') === ZERO, `${name} live keeper disabled`);
for (const fn of ['liquidityWallet', 'bnkrStakingWallet'])
  check((await call('StakedDistributor',C.distributor,fn)).toLowerCase() === C.safe, `${fn} is Safe`);
for (const [token, spender] of [[C.staked,C.distributor],[C.bnkr,C.distributor],[C.bnkr,C.vault]])
  check(await allow(token,C.bankr,spender) === 0n, 'old Bankr allowance is zero');
check(await read(C.initializer,feeAbi,'getShares',[C.poolId,C.safe]) === 950000000000000000n, 'Safe owns 95% pool fee share');
check(await read(C.initializer,feeAbi,'getShares',[C.poolId,C.bankr]) === 0n, 'Bankr pool share is zero');
check(keccak256(await pc.getBytecode({address:C.multiSendCallOnly})) === '0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939', 'MultiSendCallOnly matches official deployment hash');
observations.initialQueue = (await call('StakedDistributor',C.distributor,'pendingSwapBnkr')).toString();
observations.initialReserve = (await call('StakedVault',C.vault,'buybackReserve')).toString();
observations.bankrUsdc = (await balance(C.usdc,C.bankr)).toString();
console.log('Initial amounts', observations);

console.log('[fork] helper deployment and real Safe wiring');
const deploymentPlan = createDeploymentPlan(C,A,actor,await pc.getTransactionCount({address:actor}));
const deploymentHashes = [];
for (const d of deploymentPlan.deployments) deploymentHashes.push(await deploy(d));
const {relay,guard,executor,collector} = deploymentPlan.addresses;
const verified = await verifyDeployments(pc,C,A,deploymentPlan,deploymentHashes);
check(verified.receipts.length===4,'generated deployment calldata, runtime and constructor getters verified');
await assert.rejects(verifyDeployments(pc,C,A,deploymentPlan,[...deploymentHashes].reverse()),/Wrong deployment nonce/);
check(true,'verification rejects substituted deployment receipts');
await assert.rejects(prepareSafeBatch(pc,C,A,deploymentPlan,deploymentHashes,'fees'),/Guard executor mismatch/);
check(true,'fee-rights batch refused before helper wiring');
const wirePackage = await prepareSafeBatch(pc,C,A,deploymentPlan,deploymentHashes,'wire');
await safeBatch(wirePackage.batch.transactions,'generated wiring batch executes through real Safe and MultiSend');
check(await call('StakedAutomationGuard',guard,'paused') && await call('StakedAutomationGuard',guard,'operator')===ZERO,
  'generated wiring keeps guard paused with operator disabled');
await assert.rejects(prepareSafeBatch(pc,C,A,deploymentPlan,deploymentHashes,'wire'),/Guard was already configured/);
check(true,'migration batch refuses already configured helpers');
check((await call('StakedVault',C.vault,'distributor')).toLowerCase() === relay.toLowerCase(), 'vault points to reward relay');
check((await call('StakedDistributor',C.distributor,'vault')).toLowerCase() === relay.toLowerCase(), 'distributor points to reward relay');
check((await call('StakedDistributor',C.distributor,'pendingSwapBnkr')).toString() === observations.initialQueue, 'wiring preserves queued BNKR');
const feePackage = await prepareSafeBatch(pc,C,A,deploymentPlan,deploymentHashes,'fees');
await safeBatch(feePackage.batch.transactions,'generated fee batch settles Safe fees and moves beneficiary to collector');
check(await read(C.initializer,feeAbi,'getShares',[C.poolId,collector]) === 950000000000000000n, 'collector receives 95% rights');
check(await read(C.initializer,feeAbi,'getShares',[C.poolId,C.safe]) === 0n, 'Safe previous share removed');
await write(collector,abi('StakedFeeCollector'),'collectAndDistribute',[],outsider);
console.log('[fork] real tokens, staking and queued distribution');
const funding = 6_000_000n;
check(await balance(C.usdc,C.bankr) >= funding, 'existing Bankr USDC supports local fixture funding');
await write(C.usdc,tokenAbi,'transfer',[actor,funding],C.bankr);
const bankrStaked = await balance(C.staked,C.bankr);
const stakeAmount = bankrStaked / 10n;
check(stakeAmount > 0n, 'existing STAKED supports local staking fixture');
await write(C.staked,tokenAbi,'transfer',[actor,stakeAmount],C.bankr);
await write(C.staked,tokenAbi,'approve',[C.vault,stakeAmount]);
await write(C.vault,abi('StakedVault'),'stake',[stakeAmount]);
await write(C.usdc,tokenAbi,'transfer',[C.safe,4_000_000n]);
await safeBatch([
  tx(C.usdc,tokenAbi,'approve',[C.vault,4_000_000n]),
  tx(C.vault,abi('StakedVault'),'notifyRewardAmount',[C.usdc,4_000_000n]),
  tx(C.usdc,tokenAbi,'approve',[C.vault,0n])
], 'Safe funds real USDC reward stream on fork');
await pc.request({method:'evm_setNextBlockTimestamp',params:[Number((await pc.getBlock()).timestamp+86400n)]});
await pc.request({method:'evm_mine',params:[]});
await write(C.vault,abi('StakedVault'),'withdraw',[stakeAmount]);
const reserve = await call('StakedVault',C.vault,'buybackReserve');
check(reserve > 1n, 'real early withdrawal generates usable buyback reserve');
observations.fixtureReserve = reserve.toString();

const q3Abi = parseAbi(['function quoteExactInput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)']);
const q4Abi = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns(uint256,uint256)']);
const stateAbi = parseAbi(['function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)']);
const buyPath = encodePacked(['address','uint24','address','uint24','address'],[C.usdc,C.feeUsdcWeth,C.weth,C.feeWethBnkr,C.bnkr]);
const v3Quote = async (path,amount) => (await pc.simulateContract({address:C.v3Quoter,abi:q3Abi,functionName:'quoteExactInput',args:[path,amount]})).result[0];
const bnkrQuote = await v3Quote(buyPath,1_000_000n);
await write(C.usdc,tokenAbi,'approve',[C.v3Router,1_000_000n]);
await write(C.v3Router,abi('ISwapRouter02'),'exactInput',[{path:buyPath,recipient:actor,amountIn:1_000_000n,amountOutMinimum:bnkrQuote*99n/100n}]);
await write(C.usdc,tokenAbi,'approve',[C.v3Router,0n]);
const boughtBnkr = await balance(C.bnkr,actor);
check(boughtBnkr > 0n, 'real v3 USDC-WETH-BNKR route executes');
// Test-only donor authorization and a lower batch threshold permit a small-value fixture.
// They are executed via the actual Safe, never by patching deployed storage.
await safeBatch([
  tx(relay,abi('StakedRewardRelay'),'setYieldSource',[actor,true]),
  tx(C.distributor,abi('StakedDistributor'),'setMinBnkrBatch',[1n])
], 'Safe authorizes local donor and small fork-only batch');
report.limitations.push('Distributor minBnkrBatch is lowered to one on the fork only, to exercise a small-value batch.');
const yieldAmount = boughtBnkr / 10n;
await write(C.bnkr,tokenAbi,'approve',[relay,yieldAmount]);
const rewardsBefore = await balance(C.bnkr,C.vault);
await write(relay,abi('StakedRewardRelay'),'relayBnkr',[yieldAmount]);
check(await balance(C.bnkr,C.vault) === rewardsBefore + yieldAmount, 'real BNKR enters original vault through authorized relay');
check(await allow(C.bnkr,relay,C.vault) === 0n, 'BNKR relay allowance cleared');
const depositAmount = await balance(C.bnkr,actor);
await write(C.bnkr,tokenAbi,'approve',[C.distributor,depositAmount]);
await write(C.distributor,abi('StakedDistributor'),'depositAndDistribute',[0n,depositAmount]);
await write(C.bnkr,tokenAbi,'approve',[C.distributor,0n]);
const queued = await call('StakedDistributor',C.distributor,'pendingSwapBnkr');
const distPath = await call('StakedDistributor',C.distributor,'swapPath');
const distQuote = await v3Quote(distPath,queued);
const buyAmount = reserve / 2n < 100_000n ? reserve / 2n : 100_000n;
const middleQuote = await v3Quote(buyPath,buyAmount);
const finalQuote = (await pc.simulateContract({address:C.v4Quoter,abi:q4Abi,functionName:'quoteExactInputSingle',
  args:[{poolKey:C.poolKey,zeroForOne:true,exactAmount:middleQuote,hookData:'0x'}]})).result[0];
const [sqrtPrice] = await read(C.stateView,stateAbi,'getSlot0',[C.poolId]);
const current = await pc.getBlock();
const policy = {
  distribution:{amountIn:queued,amountOut:distQuote},buybackV3:{amountIn:buyAmount,amountOut:middleQuote},
  buybackTotal:{amountIn:buyAmount,amountOut:finalQuote},maxBnkrPerSwap:queued,maxUsdcPerBuyback:buyAmount,
  bnkrBudget:queued,usdcBudget:buyAmount,sqrtPriceLimitX96:sqrtPrice*995n/1000n,
  validUntil:Number(current.timestamp+1800n),slippageBps:100
};
await safeBatch([
  tx(guard,abi('StakedAutomationGuard'),'setOperator',[C.bankr]),
  tx(guard,abi('StakedAutomationGuard'),'setPolicy',[policy]),
  tx(guard,abi('StakedAutomationGuard'),'setPaused',[false])
], 'Safe approves bounded local trial policy');
async function deny(request,from,reason,message) {
  await assert.rejects(pc.call({...request,account:from}), error => String(error).includes(reason));
  check(true,message);
}
await deny(tx(C.distributor,abi('StakedDistributor'),'swapAndNotify',[1n]),C.bankr,'not keeper','Bankr cannot bypass guard on real distributor');
await deny(tx(C.vault,abi('StakedVault'),'executeBuyback',[buyAmount,1n]),C.bankr,'not keeper','Bankr cannot bypass guard on real vault');
await deny(tx(guard,abi('StakedAutomationGuard'),'setPolicy',[policy]),C.bankr,'not Safe','Bankr cannot change Safe price references');
const plannerOptions = {guard,v3Quoter:C.v3Quoter,v4Quoter:C.v4Quoter,slippageBps:50};
const distPlan = await prepareKeeper(pc,{...plannerOptions,mode:'distribute'});
const vaultUsdcBefore = await balance(C.usdc,C.vault);
await send({to:distPlan.to,data:distPlan.data},C.bankr);
const deliveredUsdc = await balance(C.usdc,C.vault)-vaultUsdcBefore;
check(deliveredUsdc >= distPlan.quotes.minimumUsdc,'real v3 distribution reaches original vault above floor');
check(await call('StakedDistributor',C.distributor,'pendingSwapBnkr') === 0n,'real queued batch consumed once');
check(await allow(C.usdc,C.distributor,relay) === 0n && await allow(C.usdc,relay,C.vault) === 0n,'real USDC reward allowances cleared');
await deny({to:distPlan.to,data:distPlan.data},C.bankr,'stale nonce','replayed real distribution transaction rejected');

console.log('[fork] real v4 buyback and hook settlement');
const [tightSqrt] = await read(C.stateView,stateAbi,'getSlot0',[C.poolId]);
await safeBatch([tx(guard,abi('StakedAutomationGuard'),'setPolicy',[{...policy,sqrtPriceLimitX96:tightSqrt-1n}])],
  'Safe sets deliberately restrictive v4 boundary for failure test');
const tightHead = await pc.getBlock();
const tightNonce = await call('StakedAutomationGuard',guard,'nonce');
const tightMinimumBnkr = await call('StakedAutomationGuard',guard,'buybackV3Floor',[buyAmount]);
const tightMinimumStaked = await call('StakedAutomationGuard',guard,'buybackFloor',[buyAmount]);
const tightBefore = await call('StakedVault',C.vault,'buybackReserve');
const failedHash = await wc.sendTransaction({...tx(guard,abi('StakedAutomationGuard'),'executeBuyback',
  [buyAmount,tightMinimumBnkr,tightMinimumStaked,tightHead.number,Number(tightHead.timestamp+30n),tightNonce]),
  account:C.bankr,value:0n,gas:12000000n});
const failedReceipt = await pc.waitForTransactionReceipt({hash:failedHash});
check(failedReceipt.status === 'reverted','restrictive real v4 price boundary reverts transaction');
await assert.rejects(pc.call({...tx(guard,abi('StakedAutomationGuard'),'executeBuyback',
  [buyAmount,tightMinimumBnkr,tightMinimumStaked,tightHead.number,Number(tightHead.timestamp+30n),tightNonce]),
  account:C.bankr}), /bad delta|partial v4 fill/);
check(true,'restrictive boundary failure is a rejected v4 fill');
check(await call('StakedVault',C.vault,'buybackReserve') === tightBefore,'failed real swap preserves USDC reserve');
check(await call('StakedAutomationGuard',guard,'remainingUsdc') === buyAmount && await call('StakedAutomationGuard',guard,'nonce') === tightNonce,
  'failed real swap preserves guard budget and nonce');
check(await balance(C.bnkr,executor) === 0n && await balance(C.usdc,executor) === 0n,'failed real swap leaves no intermediate assets');
await safeBatch([tx(guard,abi('StakedAutomationGuard'),'setPolicy',[policy])], 'Safe restores reviewed trial bounds');
const buyPlan = await prepareKeeper(pc,{...plannerOptions,mode:'buyback',amount:buyAmount});
const deadBefore = await balance(C.staked,DEAD);
const reserveBefore = await call('StakedVault',C.vault,'buybackReserve');
const principalBefore = await call('StakedVault',C.vault,'totalSupply');
await send({to:buyPlan.to,data:buyPlan.data},C.bankr);
const burned = await balance(C.staked,DEAD)-deadBefore;
check(burned >= buyPlan.quotes.minimumStaked,'real hook buyback delivers and burns above final floor');
check(await call('StakedVault',C.vault,'buybackReserve') === reserveBefore-buyAmount,'reserve decremented by exact USDC input');
check(await call('StakedVault',C.vault,'totalSupply') === principalBefore,'buyback leaves staker principal accounting unchanged');
check(await balance(C.bnkr,executor) === 0n && await balance(C.usdc,executor) === 0n,'real executor leaves no intermediate token residue');
check(await allow(C.usdc,executor,C.v3Router) === 0n && await allow(C.usdc,C.vault,executor) === 0n,'real buyback allowances cleared');
observations.distribution = {bnkrIn:queued.toString(),usdcOut:deliveredUsdc.toString()};
observations.buyback = {usdcIn:buyAmount.toString(),stakedBurned:burned.toString(),quotedStaked:buyPlan.quotes.quotedStaked.toString(),sqrtPriceLimitX96:policy.sqrtPriceLimitX96.toString()};

console.log('[fork] actual fee collection and rollback');
const safeStakedBefore = await balance(C.staked,C.safe);
const safeBnkrBefore = await balance(C.bnkr,C.safe);
const feeReceipt = await write(collector,abi('StakedFeeCollector'),'collectAndDistribute',[],outsider);
const forwarded = parseEventLogs({abi:abi('StakedFeeCollector'),logs:feeReceipt.logs,eventName:'FeesForwarded'});
check(forwarded.length > 0,'real trading produces claimable beneficiary fees');
const feeAmounts = forwarded[0].args;
check(await balance(C.staked,C.safe)-safeStakedBefore === feeAmounts.stakedAmount-feeAmounts.stakedAmount/2n,'collector STAKED split reaches Safe');
check(await balance(C.bnkr,C.safe)-safeBnkrBefore === feeAmounts.bnkrAmount/2n,'collector BNKR split reaches Safe');
check(await allow(C.staked,collector,C.distributor) === 0n && await allow(C.bnkr,collector,C.distributor) === 0n,'collector clears both actual token allowances');
observations.fees = {staked:feeAmounts.stakedAmount.toString(),bnkr:feeAmounts.bnkrAmount.toString()};
const rollbackPackage = await prepareSafeBatch(pc,C,A,deploymentPlan,deploymentHashes,'rollback');
await safeBatch(rollbackPackage.batch.transactions,'generated rollback executes emergency pause and beneficiary/relay recovery');
check(await call('StakedAutomationGuard',guard,'operator')===ZERO,'generated rollback disables Bankr operator');
check(await read(C.initializer,feeAbi,'getShares',[C.poolId,C.safe]) === 950000000000000000n,'rollback restores Safe 95% fee rights');
check(await read(C.initializer,feeAbi,'getShares',[C.poolId,collector]) === 0n,'rollback removes collector fee rights');
check(await call('StakedVault',C.vault,'keeper') === ZERO && await call('StakedDistributor',C.distributor,'keeper') === ZERO,'rollback disables both legacy keeper paths');
check((await call('StakedDistributor',C.distributor,'vault')).toLowerCase()===C.vault &&
  (await call('StakedVault',C.vault,'distributor')).toLowerCase()===C.distributor,'rollback restores original reward wiring');
console.log(`\n${checks} Base fork checks passed; no live transactions sent.`);
report.checks = checks;
mkdirSync('test/results',{recursive:true});
writeFileSync(`test/results/base-fork-${forkBlock}.json`,JSON.stringify(report,null,2)+'\n');
