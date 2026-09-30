// Read, quote and simulate only. No key loading, signing or transaction submission.
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi } from 'viem';
import { quoteMinimum } from './keeper-plan.mjs';

const A = JSON.parse(readFileSync(new URL('../build/all.json', import.meta.url)));
const abi = A.StakedTwapKeeperV3.abi;
const quoterAbi = parseAbi(['function quoteExactInput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)']);
const same = (a,b) => getAddress(a) === getAddress(b);

function requiredOptions(o) {
  for (const key of ['keeper','operator','safe','distributor','v3Quoter']) getAddress(o[key]);
  quoteMinimum(1n,o.slippageBps ?? 50);
}
async function state(client,o,head,requestedAmount) {
  const read = (address,a,functionName,args=[]) => client.readContract({address,abi:a,functionName,args,blockNumber:head.number});
  const k = fn => read(o.keeper,abi,fn);
  const [safe,operator,distributor,paused,nonce,limits,spent,last] = await Promise.all(
    ['safe','operator','distributor','paused','nonce','limits','spentLast24Hours','effectiveLastExecution'].map(k));
  if (!same(safe,o.safe) || !same(operator,o.operator) || !same(distributor,o.distributor)) throw new Error('Keeper identity changed');
  if (paused) throw new Error('Keeper paused');
  const [queued,threshold,path,version] = await Promise.all(['pendingSwapBnkr','minBnkrBatch','swapPath','batchSwapVersion'].map(fn => read(distributor,A.StakedDistributorV3.abi,fn)));
  if (version !== 1n) throw new Error('V3 batch distributor required');
  if (queued <= 0n || queued < threshold) throw new Error('Queue below threshold or invalid');
  const remaining = limits[1] > spent ? limits[1]-spent : 0n;
  let available = queued < limits[0] ? queued : limits[0];
  if (remaining < available) available = remaining;
  if (o.maxBnkrPerBatch !== undefined) {
    const max = BigInt(o.maxBnkrPerBatch);
    if (max <= 0n || max >= 1n << 128n) throw new Error('Invalid requested batch cap');
    if (max < available) available = max;
  }
  const amount = requestedAmount === undefined ? available : requestedAmount;
  if (amount <= 0n || amount >= 1n << 128n || amount > available || amount < threshold)
    throw new Error('Batch below threshold or exceeds available queue/spending cap');
  if (head.timestamp < BigInt(last)+BigInt(limits[4])) throw new Error('Cooldown active');
  const floor = await read(o.keeper,abi,'minimumUsdc',[amount]);
  return {amount,queued,path,floor,nonce};
}

export async function prepareTwapKeeperV3(client,o) {
  requiredOptions(o);
  if (await client.getChainId() !== 8453) throw new Error('Base mainnet required');
  const head = await client.getBlock({blockTag:'latest'});
  for (const address of [o.keeper,o.v3Quoter]) {
    const code = await client.getBytecode({address,blockNumber:head.number});
    if (!code || code === '0x') throw new Error('Missing contract');
  }
  const s = await state(client,o,head);
  const {result} = await client.simulateContract({address:o.v3Quoter,abi:quoterAbi,functionName:'quoteExactInput',args:[s.path,s.amount],blockNumber:head.number});
  const quoteFloor = quoteMinimum(result[0],o.slippageBps ?? 50);
  const minimum = quoteFloor > s.floor ? quoteFloor : s.floor;
  const deadline = head.timestamp+60n;
  const args = [s.amount,minimum,Number(deadline),s.nonce];
  const plan = {chainId:8453,from:getAddress(o.operator),to:getAddress(o.keeper),value:'0x0',
    data:encodeFunctionData({abi,functionName:'swapAndNotify',args}),quoteBlock:head.number,quoteBlockHash:head.hash,
    quoteTimestamp:head.timestamp,deadline,keeperNonce:s.nonce,
    quotes:{queuedBnkr:s.queued,bnkrIn:s.amount,quotedUsdc:result[0],minimumUsdc:minimum,twapFloor:s.floor}};
  await revalidateTwapKeeperV3(client,plan,o);
  return plan;
}

// Invoke immediately before submission. Contract checks run again at execution.
export async function revalidateTwapKeeperV3(client,plan,o) {
  requiredOptions(o);
  if (await client.getChainId() !== 8453 || plan.chainId !== 8453) throw new Error('Base mainnet required');
  if (!same(plan.to,o.keeper) || !same(plan.from,o.operator) || BigInt(plan.value)!==0n) throw new Error('Unexpected transaction');
  const {functionName,args} = decodeFunctionData({abi,data:plan.data});
  if (functionName!=='swapAndNotify' || encodeFunctionData({abi,functionName,args}).toLowerCase()!==plan.data.toLowerCase()) throw new Error('Unexpected calldata');
  const head = await client.getBlock({blockTag:'latest'});
  const quoted = await client.getBlock({blockNumber:BigInt(plan.quoteBlock)});
  if (quoted.hash!==plan.quoteBlockHash || quoted.timestamp!==BigInt(plan.quoteTimestamp)) throw new Error('Quote block changed');
  if (head.number<quoted.number || head.timestamp<quoted.timestamp || head.timestamp-quoted.timestamp>15n) throw new Error('Quote stale; prepare again');
  if (BigInt(args[2])!==BigInt(plan.deadline) || args[3]!==BigInt(plan.keeperNonce) || BigInt(args[2])<=head.timestamp || BigInt(args[2])>head.timestamp+120n) throw new Error('Invalid deadline or nonce metadata');
  const s = await state(client,o,head,args[0]);
  if (args[0]!==s.amount || args[3]!==s.nonce) throw new Error('Queue or nonce changed');
  if (args[0]!==BigInt(plan.quotes.bnkrIn) || args[1]!==BigInt(plan.quotes.minimumUsdc)) throw new Error('Quote amount/minimum metadata changed');
  if (args[1]<s.floor) throw new Error('Minimum below live TWAP floor');
  await client.simulateContract({address:o.keeper,abi,functionName,args,account:o.operator,blockNumber:head.number});
  const final = await client.getBlock({blockTag:'latest'});
  if (final.timestamp<quoted.timestamp || final.timestamp-quoted.timestamp>15n || final.timestamp>=BigInt(args[2])) throw new Error('Quote expired during validation');
  if ((await client.getBlock({blockNumber:head.number})).hash!==head.hash) throw new Error('Validation block reorganized');
  return {block:head.number,deadline:BigInt(args[2]),broadcast:false};
}
