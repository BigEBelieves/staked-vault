import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { parseAmount, checkWallet, friendlyError, walletDeepLink } from '../web/src/safety.js';

test('exact decimal amounts preserve wei without floating point rounding', () => {
  assert.equal(parseAmount('123.000000000000000001').toString(), '123000000000000000001');
  assert.equal(parseAmount('0.000000000000000001').toString(), '1');
});
test('invalid amounts cannot become an approval or stake', () => {
  for (const value of ['0','-1','1e5','Infinity','NaN','.5','1.','1.0000000000000000001','0x10','',ethers.constants.MaxUint256.toString()]) {
    assert.throws(() => parseAmount(value));
  }
});
test('wallet context requires Base and the currently connected account', async () => {
  const account = '0x1111111111111111111111111111111111111111';
  const provider = (chain, accounts) => ({send: async method => method === 'eth_chainId' ? chain : accounts});
  await checkWallet(provider('0x2105',[account]),account);
  await assert.rejects(checkWallet(provider('0x1',[account]),account),{code:'WRONG_CHAIN'});
  await assert.rejects(checkWallet(provider('0x2105',[]),account),{code:'ACCOUNT_CHANGED'});
  await assert.rejects(checkWallet(provider('0x2105',['0x2222222222222222222222222222222222222222']),account),{code:'ACCOUNT_CHANGED'});
  await assert.rejects(checkWallet(null,account),{code:'NOT_CONNECTED'});
});
test('user-facing errors never echo raw RPC payloads or URLs', () => {
  for (const code of [4001,4900,'CALL_EXCEPTION','SERVER_ERROR','UNPREDICTABLE_GAS_LIMIT','UNKNOWN_ERROR']) {
    const message = friendlyError({code,message:'https://phishing.invalid/?rpc_secret=123 <script>attack</script>'});
    assert.doesNotMatch(message,/https:|rpc_secret|script|attack/);
  }
  assert.match(friendlyError({error:{code:4001}}),/cancelled/);
  assert.match(friendlyError({code:'ACCOUNT_CHANGED'}),/Reconnect/);
  assert.match(friendlyError({code:'TRANSACTION_REPLACED'}),/final status/);
});
test('registry deep links accept safe wallet schemes and HTTPS universal links', () => {
  const uri='wc:topic@2?relay-protocol=irn&symKey=abc';
  assert.equal(walletDeepLink({mobile:{native:'rainbow://'}},uri),'rainbow://wc?uri='+encodeURIComponent(uri));
  assert.equal(walletDeepLink({mobile:{universal:'https://wallet.example/app/'}},uri),'https://wallet.example/app/wc?uri='+encodeURIComponent(uri));
});
test('untrusted registry entries cannot inject executable or credentialed links', () => {
  for (const native of ['javascript:','data:','file://','https://','javascript:alert(1)','x://evil/path'])
    assert.equal(walletDeepLink({mobile:{native}},'wc:topic'), '');
  for (const universal of ['javascript:alert(1)','http://wallet.example','https://user:pass@wallet.example','https://wallet.example/?redirect=bad'])
    assert.equal(walletDeepLink({mobile:{universal}},'wc:topic'), '');
  assert.equal(walletDeepLink({mobile:{native:'rainbow://'}},'https://bad.invalid'), '');
});
