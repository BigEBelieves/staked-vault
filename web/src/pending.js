import { checkWallet } from './safety.js';

const key = account => 'staked:base:pending:' + account.toLowerCase();
export function pendingRequest(account) {
  if (!account) return null;
  try {
    const raw = localStorage.getItem(key(account));
    if (raw === null) return null;
    const r = JSON.parse(raw);
    const address = x => typeof x === 'string' && /^0x[0-9a-f]{40}$/i.test(x);
    if (!r || Array.isArray(r) || !address(r.account) || r.account.toLowerCase() !== account.toLowerCase() ||
        !address(r.to) || typeof r.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(r.data) ||
        !Number.isSafeInteger(r.nonce) || r.nonce < 0 || !Number.isSafeInteger(r.block) || r.block < 0 ||
        typeof r.method !== 'string' || !(r.hash === null || /^0x[0-9a-f]{64}$/i.test(r.hash)))
      return {invalid:true};
    return r;
  } catch { return {invalid:true}; }
}
export async function sendTracked(provider, account, contract, method, args = []) {
  if (!navigator.locks) throw new Error('Transaction locking unavailable. Use a current browser over HTTPS.');
  return navigator.locks.request(key(account), { ifAvailable: true }, async lock => {
    if (!lock || pendingRequest(account)) throw new Error('Check the previous wallet request before submitting another.');
    await checkWallet(provider, account);
    const request = await contract.populateTransaction[method](...args);
    const [nonce, block] = await Promise.all([provider.getTransactionCount(account, 'pending'), provider.getBlockNumber()]);
    await checkWallet(provider, account);
    const record = { account, to: request.to, data: request.data, nonce, block, method, hash: null };
    // Persist BEFORE the wallet request. An ambiguous failure must survive reloads.
    localStorage.setItem(key(account), JSON.stringify(record));
    try {
      const tx = await contract[method](...args);
      record.hash = tx.hash;
      localStorage.setItem(key(account), JSON.stringify(record));
      const receipt = await tx.wait();
      if (receipt?.blockNumber) localStorage.removeItem(key(account));
      return receipt;
    } catch (error) {
      // Only explicit rejection or a mined receipt resolves an uncertain send.
      if ([4001, 'ACTION_REJECTED'].includes(error.code) || error.receipt?.blockNumber)
        localStorage.removeItem(key(account));
      throw error;
    }
  });
}

export async function recoverPending(provider, account, suppliedHash) {
  await checkWallet(provider, account);
  const saved = pendingRequest(account);
  if (!saved) return false;
  if (saved.invalid) throw new Error("Saved request cannot be verified. Contact support; do not resend.");
  const hash = saved.hash || suppliedHash.trim();
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Enter the transaction hash shown in your wallet activity.');
  const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
  if (!tx || !receipt?.blockNumber) throw new Error('This transaction is not confirmed yet. Check your wallet activity.');
  if (tx.from.toLowerCase() !== account.toLowerCase() || tx.nonce !== saved.nonce || receipt.blockNumber < saved.block)
    throw new Error('This transaction does not resolve the saved wallet request.');
  // A mined replacement at the same sender nonce also resolves the old request.
  localStorage.removeItem(key(account));
  return receipt.status === 1 && tx.to?.toLowerCase() === saved.to.toLowerCase() && tx.data === saved.data;
}
