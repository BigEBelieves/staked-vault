import assert from 'node:assert/strict';
// Return only allowlisted categories and source locations, never raw errors.
export function publicFailure(stderr){
 const categories=[
  ['rate limit',/rate.limit|too many requests|\b429\b/i],
  ['read upstream failed',/Read-only upstream failed/],
  ['archive state unavailable',/missing trie node|historical state|state is not available/i],
  ['log range rejected',/blocks? range|range.{0,20}(?:limit|block)|query returned more than|too many blocks|eth_getLogs.{0,40}limited/i],
  ['execution reverted',/execution reverted|Local transaction reverted/i],
  ['assertion failed',/AssertionError/],
  ['connection timeout',/connect.*timed out|connection timeout|TimeoutError|request took too long/i],
  ['invalid RPC parameters',/invalid (?:argument|params|parameters)/i],
  ['read transport failure',/RPC read transport failed/],
 ];
 return {
  categories:categories.filter(([,pattern])=>pattern.test(stderr)).map(([label])=>label),
  errorTypes:[...new Set(stderr.match(/\b(?:ContractFunctionExecutionError|ContractFunctionRevertedError|RpcRequestError|HttpRequestError|InvalidInputRpcError|UnknownRpcError|AssertionError|TypeError|SyntaxError)\b/g)??[])],
  sourceLocations:[...new Set([...stderr.matchAll(/\b((?:scripts\/(?:v3-migration|twap-keeper-v3-plan)|test\/v3-migration-fork\.test)\.mjs:\d+:\d+)/g)].map(m=>m[1]))],
  guardRejections:['stale pool','thin liquidity','price deviation','input too large for liquidity','invalid observation','invalid liquidity history','invalid harmonic liquidity','pool locked/uninitialized','empty quote','quote overflow/zero'].filter(reason=>stderr.includes(reason)),
  rpcFailures:[...stderr.matchAll(/RPC_DIAGNOSTIC (\{[^\n]+\})/g)].flatMap(m=>{
   try{
    const x=JSON.parse(m[1]);if(!['eth_chainId','net_version','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getBalance','eth_getTransactionCount','eth_getCode','eth_getStorageAt','eth_getProof','eth_call','eth_getTransactionByHash','eth_getTransactionReceipt','eth_getLogs','eth_gasPrice'].includes(x.method))return [];
    return [{method:x.method,...Object.fromEntries(['httpStatus','rpcCode','curlCode'].filter(k=>Number.isSafeInteger(x[k])).map(k=>[k,x[k]]))}];
   }catch{return [];}
  }).slice(-10),
 };
}
// Publish only execution evidence. Never return the private snapshot, balances,
// signer addresses, deployment calldata or copied wallet positions.
export function publicSummary(report,block,hash,commit){
 assert.equal(report.mode,'LOCAL FORK ONLY — no live writes');
 assert.equal(String(report.block),String(block));assert.equal(report.blockHash,hash);
 assert.match(commit,/^[0-9a-f]{40}$/);assert(Number.isSafeInteger(report.checks)&&report.checks>=50);
 const o=report.observations;
 assert(BigInt(o.initial.principal)>0n);
 assert.equal(o.redemption.principalReturned,o.initial.principal);
 assert.equal(BigInt(o.redemption.newPrincipalAfterExit),0n);assert(BigInt(o.redemption.usdcPaid)>0n);
 for(const token of ['usdc','bnkr']){
  assert(BigInt(o.claimPreservation.earnedBefore[token])>0n);
  assert.equal(o.claimPreservation.claimedAfterCutover[token],o.claimPreservation.earnedBefore[token]);
 }
 assert(BigInt(o.swap.usdcReceived)>=BigInt(o.swap.minimumUsdc));assert(BigInt(o.swap.bnkrIn)>0n);
 assert.equal(o.rollback.newPrincipal,o.initial.principal);
 return {status:'passed',mode:'Local Base fork; no live writes',commit,block:String(block),blockHash:hash,checks:report.checks,
  oldRewardClaimsPreserved:true,principalRedeemed:true,guardedConversionAboveMinimum:true,rollbackPreservesPrincipal:true,
  liveTransactionsSent:0,limitations:['Simulated Safe signatures and fork-only ETH.','No live deployment, real wallet signing, scheduled job or fresh unsigned deployment plan verified.']};
}
