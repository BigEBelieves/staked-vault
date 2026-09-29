import { decodeFunctionData, encodeFunctionData, encodePacked, getAddress, parseAbi } from 'viem';
import { readFileSync } from 'node:fs';

const artifacts = JSON.parse(readFileSync(new URL('../build/all.json', import.meta.url)));
const abi = name => artifacts[name].abi;
export const v3Quoter = parseAbi(['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)']);
export const v4Quoter = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)']);

export function quoteMinimum(output, slippageBps = 50) {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 100) throw new Error('Slippage must be 0–100 bps');
  if (output <= 0n) throw new Error('Empty quote');
  return (output * BigInt(10_000 - slippageBps) + 9999n) / 10000n;
}
const greater = (a, b) => a > b ? a : b;

// Solidity's public struct getter returns an array containing three Quote tuples.
async function executionState(read, guard, timestamp) {
  const [paused, policy, remainingBnkr, remainingUsdc] = await Promise.all(
    ['paused', 'policy', 'remainingBnkr', 'remainingUsdc'].map(fn => read(guard, 'StakedAutomationGuard', fn)));
  if (paused) throw new Error('Trading paused');
  if (BigInt(policy[8]) <= timestamp) throw new Error('Trading policy expired');
  return { policy, remainingBnkr, remainingUsdc };
}

function distributionReady(amount, minimum, state) {
  if (amount <= 0n || amount > (1n << 128n) - 1n) throw new Error('No queued BNKR or queue exceeds uint128');
  if (amount < minimum) throw new Error('BNKR queue below minimum batch');
  if (amount > state.policy[3] || amount > state.remainingBnkr) throw new Error('Full BNKR queue exceeds policy cap or remaining budget');
}

function buybackReady(amount, reserve, state) {
  if (amount <= 0n || amount > (1n << 128n) - 1n) throw new Error('Buyback amount must be positive uint128 raw USDC units');
  if (amount > reserve) throw new Error('Insufficient buyback reserve');
  if (amount > state.policy[4] || amount > state.remainingUsdc) throw new Error('Buyback exceeds policy cap or remaining budget');
}

/// Read/quote/simulate only. The caller owns signing and private submission; this module never broadcasts.
export async function prepareKeeper(client, options) {
  const { mode, guard: guardAddress, v3Quoter: q3, v4Quoter: q4, slippageBps = 50 } = options;
  quoteMinimum(1n, slippageBps); // Validate before any RPC calls.
  if (!['distribute', 'buyback'].includes(mode)) throw new Error('Mode must be distribute or buyback');
  if (await client.getChainId() !== 8453) throw new Error('Base mainnet required');
  const guard = getAddress(guardAddress);
  const head = await client.getBlock({ blockTag: 'latest' });
  const read = (address, name, functionName, args = []) => client.readContract({ address, abi: abi(name), functionName, args, blockNumber: head.number });
  for (const address of [guard, q3, ...(mode === 'buyback' ? [q4] : [])]) {
    if (!address) throw new Error('Explicit verified quoter addresses required');
    const code = await client.getBytecode({ address: getAddress(address), blockNumber: head.number });
    if (!code || code === '0x') throw new Error('Missing guard/quoter code');
  }
  const operator = await read(guard, 'StakedAutomationGuard', 'operator');
  if (/^0x0{40}$/i.test(operator)) throw new Error('Operator disabled');
  const nonce = await read(guard, 'StakedAutomationGuard', 'nonce');
  const state = await executionState(read, guard, head.timestamp);
  const expiry = BigInt(state.policy[8]);
  const deadline = head.timestamp + 30n < expiry ? head.timestamp + 30n : expiry;
  const commonArgs = [head.number, Number(deadline), nonce];
  let functionName, args, quotes;
  if (mode === 'distribute') {
    const distributor = await read(guard, 'StakedAutomationGuard', 'distributor');
    const amount = await read(distributor, 'StakedDistributor', 'pendingSwapBnkr');
    distributionReady(amount, await read(distributor, 'StakedDistributor', 'minBnkrBatch'), state);
    const path = await read(distributor, 'StakedDistributor', 'swapPath');
    const { result } = await client.simulateContract({ address: q3, abi: v3Quoter, functionName: 'quoteExactInput', args: [path, amount], blockNumber: head.number });
    const minimum = greater(quoteMinimum(result[0], slippageBps), await read(guard, 'StakedAutomationGuard', 'distributionFloor', [amount]));
    functionName = 'swapAndNotify';
    args = [amount, minimum, ...commonArgs];
    quotes = { amountIn: amount, quotedUsdc: result[0], minimumUsdc: minimum };
  } else {
    const amount = BigInt(options.amount ?? 0);
    const vault = await read(guard, 'StakedAutomationGuard', 'vault');
    buybackReady(amount, await read(vault, 'StakedVault', 'buybackReserve'), state);
    const executor = await read(guard, 'StakedAutomationGuard', 'executor');
    const e = name => read(executor, 'StakedBoundedBuybackExecutor', name);
    const [usdc, weth, bnkr, fee0, fee1, key, zeroForOne] = await Promise.all([
      e('usdc'), e('weth'), e('bnkr'), e('feeUsdcWeth'), e('feeWethBnkr'), e('poolKey'), e('bnkrIsCurrency0')
    ]);
    const path = encodePacked(['address', 'uint24', 'address', 'uint24', 'address'], [usdc, fee0, weth, fee1, bnkr]);
    const first = await client.simulateContract({ address: q3, abi: v3Quoter, functionName: 'quoteExactInput', args: [path, amount], blockNumber: head.number });
    const bnkrOut = first.result[0];
    if (bnkrOut <= 0n || bnkrOut > (1n << 127n) - 1n) throw new Error('V3 quote exceeds executor bounds');
    const poolKey = { currency0: key[0], currency1: key[1], fee: key[2], tickSpacing: key[3], hooks: key[4] };
    const second = await client.simulateContract({ address: q4, abi: v4Quoter, functionName: 'quoteExactInputSingle',
      args: [{ poolKey, zeroForOne, exactAmount: bnkrOut, hookData: '0x' }], blockNumber: head.number });
    const minBnkr = greater(quoteMinimum(bnkrOut, slippageBps), await read(guard, 'StakedAutomationGuard', 'buybackV3Floor', [amount]));
    const minStaked = greater(quoteMinimum(second.result[0], slippageBps), await read(guard, 'StakedAutomationGuard', 'buybackFloor', [amount]));
    functionName = 'executeBuyback';
    args = [amount, minBnkr, minStaked, ...commonArgs];
    quotes = { amountIn: amount, quotedBnkr: bnkrOut, quotedStaked: second.result[0], minimumBnkr: minBnkr, minimumStaked: minStaked };
  }
  await client.simulateContract({ address: guard, abi: abi('StakedAutomationGuard'), functionName, args, account: operator, blockNumber: head.number });
  const latest = await client.getBlock({ blockTag: 'latest' });
  if (latest.number !== head.number || latest.hash !== head.hash) throw new Error('Head changed while quoting; requote before signing');
  return { chainId: 8453, from: operator, to: guard, value: '0x0',
    data: encodeFunctionData({ abi: abi('StakedAutomationGuard'), functionName, args }),
    quoteBlock: head.number, quoteBlockHash: head.hash, deadline, guardNonce: nonce, quotes };
}

// Call again after wallet signing and immediately before the separately verified private sender.
// This validates the unsigned plan, not a wallet's signed bytes, and never sends a transaction.
export async function revalidateKeeper(client, plan, { guard: expectedGuard, operator: expectedOperator }) {
  if (await client.getChainId() !== 8453 || plan.chainId !== 8453) throw new Error('Base mainnet required');
  if (getAddress(plan.to) !== getAddress(expectedGuard) || getAddress(plan.from) !== getAddress(expectedOperator) || BigInt(plan.value) !== 0n)
    throw new Error('Unexpected keeper destination, sender or value');
  const { functionName, args } = decodeFunctionData({ abi: abi('StakedAutomationGuard'), data: plan.data });
  if (!['swapAndNotify', 'executeBuyback'].includes(functionName)) throw new Error('Unsupported keeper call');
  if (encodeFunctionData({abi:abi('StakedAutomationGuard'),functionName,args}).toLowerCase() !== plan.data.toLowerCase()) throw new Error('Noncanonical keeper calldata');
  const [quoteBlock, deadline, nonce] = args.slice(-3);
  if (quoteBlock !== BigInt(plan.quoteBlock) || BigInt(deadline) !== BigInt(plan.deadline) || nonce !== BigInt(plan.guardNonce))
    throw new Error('Keeper metadata differs from calldata');
  const head = await client.getBlock({ blockTag: 'latest' });
  if (quoteBlock > head.number || head.number - quoteBlock > 2n) throw new Error('Stale quote block; requote');
  if (BigInt(deadline) <= head.timestamp || BigInt(deadline) > head.timestamp + 60n) throw new Error('Expired or invalid keeper deadline');
  if ((await client.getBlock({ blockNumber: quoteBlock })).hash !== plan.quoteBlockHash) throw new Error('Quote block reorganized');
  const read = (address, name, fn, values = []) => client.readContract({address, abi: abi(name), functionName: fn, args: values, blockNumber: head.number});
  if (getAddress(await read(plan.to, 'StakedAutomationGuard', 'operator')) !== getAddress(expectedOperator)) throw new Error('Operator changed');
  if (await read(plan.to, 'StakedAutomationGuard', 'nonce') !== nonce) throw new Error('Guard nonce changed');
  const state = await executionState(read, plan.to, head.timestamp);
  if (functionName === 'swapAndNotify') {
    const distributor = await read(plan.to, 'StakedAutomationGuard', 'distributor');
    const amount = await read(distributor, 'StakedDistributor', 'pendingSwapBnkr');
    if (amount !== args[0]) throw new Error('BNKR queue changed');
    distributionReady(amount, await read(distributor, 'StakedDistributor', 'minBnkrBatch'), state);
  } else {
    const vault = await read(plan.to, 'StakedAutomationGuard', 'vault');
    buybackReady(args[0], await read(vault, 'StakedVault', 'buybackReserve'), state);
  }
  await client.simulateContract({address: plan.to, abi: abi('StakedAutomationGuard'), functionName, args, account: plan.from, blockNumber: head.number});
  const finalHead = await client.getBlock({ blockTag: 'latest' });
  if (finalHead.number !== head.number || finalHead.hash !== head.hash) throw new Error('Head changed during final validation; revalidate');
  return { block: head.number, blockHash: head.hash, deadline: BigInt(deadline), guardNonce: nonce, broadcast: false };
}
