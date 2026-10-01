import { ethers } from 'ethers';

export function parseAmount(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(text)) throw Object.assign(new Error('Invalid amount'), { code: 'INVALID_AMOUNT' });
  const amount = ethers.utils.parseUnits(text, 18);
  if (amount.lte(0) || amount.gt(ethers.constants.MaxUint256)) throw Object.assign(new Error('Invalid amount'), { code: 'INVALID_AMOUNT' });
  return amount;
}

export async function checkWallet(provider, account) {
  if (!provider || !account) throw Object.assign(new Error('Connect first'), { code: 'NOT_CONNECTED' });
  const [chain, accounts] = await Promise.all([provider.send('eth_chainId', []), provider.send('eth_accounts', [])]);
  if (Number(chain) !== 8453) throw Object.assign(new Error('Wrong network'), { code: 'WRONG_CHAIN' });
  if (!accounts?.length || accounts[0].toLowerCase() !== account.toLowerCase())
    throw Object.assign(new Error('Account changed'), { code: 'ACCOUNT_CHANGED' });
}

export function friendlyError(error, action = 'complete this request') {
  const parts = [];
  let e = error;
  for (let i = 0; e && i < 4; i++, e = e.error ?? e.cause) parts.push({ code: e.code, message: String(e.reason ?? e.message ?? '') });
  const has = (...codes) => parts.some(p => codes.includes(p.code));
  const matches = re => parts.some(p => re.test(p.message));
  if (has(4001, 'ACTION_REJECTED') || matches(/user (?:rejected|denied|closed)|request rejected/i)) return 'Request cancelled in your wallet. Nothing was submitted by this action.';
  if (has('WRONG_CHAIN', 4902)) return 'Switch your wallet to Base and try again.';
  if (has('ACCOUNT_CHANGED')) return 'Your wallet account changed. Reconnect and review the amount again.';
  if (has('NOT_CONNECTED', 4100)) return 'Connect your wallet before continuing.';
  if (has(-32002)) return 'A request is already waiting in your wallet. Open it to continue.';
  if (has('INVALID_AMOUNT', 'NUMERIC_FAULT')) return 'Enter a positive token amount with no more than 18 decimal places.';
  if (has('INSUFFICIENT_BALANCE')) return 'Your token balance is too low for that amount.';
  if (has('APPROVAL_REQUIRED')) return 'Approve the amount you want to stake, then try again.';
  if (has('INSUFFICIENT_FUNDS') || matches(/insufficient funds for (?:gas|intrinsic)/i)) return 'You need more ETH on Base to pay the transaction fee.';
  if (has('TRANSACTION_REPLACED')) return 'The transaction was replaced in your wallet. Check its final status before retrying.';
  if (has('LOCKED') || matches(/(?:reverted:|reason=|revert )?["']?locked["']?$/i)) return 'Your stake is still locked. Wait until it unlocks or review the explicit early-withdrawal option.';
  if (has('NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 4900, 4901) || matches(/rate.?limit|too many requests|failed to fetch|timeout|network error|\b429\b/i)) return 'Base data is temporarily unavailable. Wait a moment and try again.';
  if (has('UNPREDICTABLE_GAS_LIMIT', 'CALL_EXCEPTION')) return 'The contract could not complete this action. Refresh your balances and review the amount and lock status.';
  return `Could not ${action}. Check your wallet activity before retrying.`;
}

export function walletDeepLink(wallet, uri) {
  if (!wallet?.mobile || typeof uri !== 'string' || !uri.startsWith('wc:')) return '';
  const encoded = encodeURIComponent(uri);
  if (wallet.mobile.universal) {
    try {
      const url = new URL(wallet.mobile.universal);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
      return url.href.replace(/\/+$/, '') + '/wc?uri=' + encoded;
    } catch { return ''; }
  }
  const native = wallet.mobile.native;
  if (typeof native !== 'string' || !/^[a-z][a-z0-9+.-]*:(?:\/\/)?\/?$/i.test(native)) return '';
  const scheme = native.split(':')[0].toLowerCase();
  if (['javascript', 'data', 'file', 'blob', 'http', 'https', 'vbscript'].includes(scheme)) return '';
  return scheme + '://wc?uri=' + encoded;
}
