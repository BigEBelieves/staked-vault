import { encodeFunctionData, encodePacked, getAddress, parseAbi } from 'viem';
import { readFileSync } from 'node:fs';

const artifacts = JSON.parse(readFileSync(new URL('../build/all.json', import.meta.url)));
const abi = name => artifacts[name].abi;
const v3Quoter = parseAbi(['function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)']);
const v4Quoter = parseAbi(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)']);

export function quoteMinimum(output, slippageBps = 50) {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 100) throw new Error('Slippage must be 0–100 bps');
  if (output <= 0n) throw new Error('Empty quote');
  return (output * BigInt(10_000 - slippageBps) + 9999n) / 10000n;
}
const greater = (a, b) => a > b ? a : b;

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
  const deadline = head.timestamp + 30n;
  const commonArgs = [head.number, Number(deadline), nonce];
  let functionName, args, quotes;
  if (mode === 'distribute') {
    const distributor = await read(guard, 'StakedAutomationGuard', 'distributor');
    const amount = await read(distributor, 'StakedDistributor', 'pendingSwapBnkr');
    if (amount === 0n) throw new Error('No queued BNKR');
    const path = await read(distributor, 'StakedDistributor', 'swapPath');
    const { result } = await client.simulateContract({ address: q3, abi: v3Quoter, functionName: 'quoteExactInput', args: [path, amount], blockNumber: head.number });
    const minimum = greater(quoteMinimum(result[0], slippageBps), await read(guard, 'StakedAutomationGuard', 'distributionFloor', [amount]));
    functionName = 'swapAndNotify';
    args = [amount, minimum, ...commonArgs];
    quotes = { amountIn: amount, quotedUsdc: result[0], minimumUsdc: minimum };
  } else {
    const amount = BigInt(options.amount ?? 0);
    if (amount <= 0n || amount > (1n << 128n) - 1n) throw new Error('Buyback amount must be positive uint128 raw USDC units');
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
