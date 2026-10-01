import { ethers } from 'ethers';
import { CONFIG, LEGACY, readProvider } from './config.js';

export const BNKR_STAKING = {
  safe: '0xb9066550918fa778a4039120eac878230cf8f6FC',
  adapter: '0xf495bf917d159942acc6c926ab883d5a20cf2a05',
  staking: '0x88470240ff0663faefa68b1d7621b472ddd9584a'
};
const adapterAbi = [
  'function idlePrincipal() view returns(uint256)',
  'function paused() view returns(bool)',
  'function staking() view returns(address)',
  'function safe() view returns(address)'
];
export async function readBnkrStats(provider) {
  const block = await provider.getBlockNumber();
  const opts = { blockTag: block };
  const adapter = new ethers.Contract(BNKR_STAKING.adapter, adapterAbi, provider);
  const token = new ethers.Contract(CONFIG.BNKR_TOKEN, ['function balanceOf(address) view returns(uint256)'], provider);
  const staking = new ethers.Contract(BNKR_STAKING.staking, ['function stakeOf(address) view returns(uint256)'], provider);
  const [idle, paused, target, safe, active, safeBalance] = await Promise.all([
    adapter.idlePrincipal(opts), adapter.paused(opts), adapter.staking(opts), adapter.safe(opts),
    staking.stakeOf(BNKR_STAKING.adapter, opts), token.balanceOf(BNKR_STAKING.safe, opts)
  ]);
  if (target.toLowerCase() !== BNKR_STAKING.staking || safe.toLowerCase() !== BNKR_STAKING.safe.toLowerCase()) throw new Error('Staking identity mismatch');
  return { idle, paused, active, safeBalance, block };
}
export function formatBnkr(value) {
  if (value.isZero()) return '0';
  if (value.lt(ethers.utils.parseEther('0.01'))) return '<0.01';
  return Number(ethers.utils.formatEther(value)).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
let loading = false;
export async function refreshBnkrStats() {
  if (LEGACY || loading) return;
  loading = true;
  const el = id => document.getElementById(id);
  try {
    const stats = await readBnkrStats(readProvider);
    el('bnkrAwaiting').textContent = formatBnkr(stats.idle);
    el('bnkrActive').textContent = formatBnkr(stats.active);
    el('bnkrSafe').textContent = formatBnkr(stats.safeBalance);
    el('bnkrStakingStatus').textContent = stats.paused ? 'Staking deposits paused' : 'Staking deposits enabled';
    el('bnkrStatsUpdated').textContent = `Updated ${new Date().toLocaleTimeString()} · Base block ${stats.block.toLocaleString()}`;
  } catch {
    for (const id of ['bnkrAwaiting', 'bnkrActive', 'bnkrSafe']) el(id).textContent = 'Unavailable';
    el('bnkrStakingStatus').textContent = 'Could not load staking status';
    el('bnkrStatsUpdated').textContent = 'Balance reads failed. Refresh to try again.';
  } finally { loading = false; }
}
const section = document.getElementById('bnkrProtocolStats');
if (LEGACY) section.hidden = true;
else {
  document.getElementById('refreshBnkrStats').addEventListener('click', refreshBnkrStats);
  window.addEventListener('load', refreshBnkrStats);
  setInterval(() => { if (!document.hidden) refreshBnkrStats(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBnkrStats(); });
}
