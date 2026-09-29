import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { prepareKeeper } from './keeper-plan.mjs';

// Intentionally no private-key handling, signing, or public-RPC fallback.
const url = process.env.PRIVATE_BASE_RPC_URL;
if (!url) throw new Error('Set PRIVATE_BASE_RPC_URL to a provider whose Base private-submission support you have verified');
const client = createPublicClient({ chain: base, transport: http(url, { retryCount: 0 }), cacheTime: 0 });
try {
  const plan = await prepareKeeper(client, {
    mode: process.argv[2], amount: process.argv[3], guard: process.env.GUARD_ADDRESS,
    v3Quoter: process.env.V3_QUOTER_ADDRESS, v4Quoter: process.env.V4_QUOTER_ADDRESS,
    slippageBps: Number(process.env.SLIPPAGE_BPS ?? 50)
  });
  console.log(JSON.stringify(plan, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
} catch (error) {
  // Avoid echoing an RPC URL or credentials included in a provider's nested error.
  console.error(error.shortMessage ?? error.message?.split('\n')[0] ?? 'Preparation failed');
  process.exitCode = 1;
}
