import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicSummary} from '../scripts/fork/ci-summary.mjs';
const hash='0x'+'1'.repeat(64),commit='2'.repeat(40);
const fixture=()=>({mode:'LOCAL FORK ONLY — no live writes',block:'500',blockHash:hash,checks:60,snapshot:{private:'PRIVATE_POSITION'},deploymentPlan:{private:'PRIVATE_CALLDATA'},observations:{initial:{principal:'1000'},redemption:{principalReturned:'1000',newPrincipalAfterExit:'0',usdcPaid:'50'},claimPreservation:{earnedBefore:{usdc:'12',bnkr:'34'},claimedAfterCutover:{usdc:'12',bnkr:'34'}},swap:{usdcReceived:'50',minimumUsdc:'49',bnkrIn:'80'},rollback:{newPrincipal:'1000'}}});
test('published result excludes private snapshot, amounts and deployment data',()=>{
 const s=publicSummary(fixture(),'500',hash,commit),json=JSON.stringify(s);
 assert.equal(s.status,'passed');assert.equal(s.liveTransactionsSent,0);
 for(const value of ['PRIVATE_POSITION','PRIVATE_CALLDATA','1000','earnedBefore','observations','snapshot'])assert(!json.includes(value));
});
test('failed preservation or output cannot be presented as success',()=>{
 for(const alter of [r=>r.observations.redemption.principalReturned='999',r=>r.observations.redemption.newPrincipalAfterExit='1',r=>r.observations.redemption.usdcPaid='0',r=>r.observations.claimPreservation.claimedAfterCutover.bnkr='33',r=>r.observations.swap.usdcReceived='48',r=>r.observations.rollback.newPrincipal='999',r=>r.checks=0]){
  const r=fixture();alter(r);assert.throws(()=>publicSummary(r,'500',hash,commit));
 }
});
test('wrong network snapshot or malformed source identity cannot be published',()=>{
 assert.throws(()=>publicSummary(fixture(),'501',hash,commit));assert.throws(()=>publicSummary(fixture(),'500','0x'+'3'.repeat(64),commit));assert.throws(()=>publicSummary(fixture(),'500',hash,'branch-name'));
});
