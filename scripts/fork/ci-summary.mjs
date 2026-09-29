import assert from 'node:assert/strict';
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
