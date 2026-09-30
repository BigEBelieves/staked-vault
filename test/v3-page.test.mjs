import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,plan,build} from './v3-page-fixture.mjs';
import {authenticateV3Plan} from '../v3-deployment/validate.mjs';
import {DeploymentSession} from '../deployment/engine.mjs';
test('version-3 planner creates exactly the five authenticated creations',()=>{
 const p=authenticateV3Plan(plan,build);assert.equal(p.plan.deployments.length,5);assert.deepEqual(p.plan.deployments,plan.deployments);
 assert(p.verification[3].calls.some(c=>c.name==='predecessor'));assert(p.verification[3].calls.some(c=>c.name==='paused'));
});
test('old manifests, altered constructors, nonce, owner, limits and destinations fail closed',()=>{
 const mutations=[p=>p.version=2,p=>p.chainId=1,p=>p.safe=plan.deployer,p=>p.firstNonce='207',p=>p.minBnkrBatch='1',p=>p.reviewedLimits.maxBnkrPer24Hours='999999999999999999999999',p=>p.addresses.keeper=plan.deployer,p=>p.deployments.reverse(),p=>p.deployments[3].data+='00',p=>p.deployments[0].to=plan.safe,p=>p.deployments[0].value='1',p=>p.deployments[0].from=plan.safe];
 for(const mutate of mutations){const p=structuredClone(plan);mutate(p);assert.throws(()=>authenticateV3Plan(p,build));}
});
test('imported verification overrides cannot replace trusted runtime or getter checks',()=>{
 const p=structuredClone(plan);p.verification=[];p.gasOracle=plan.deployer;
 const trusted=authenticateV3Plan(p,build);assert.equal(trusted.verification.length,5);assert.notEqual(trusted.gasOracle,p.gasOracle);
});
test('five explicit approvals verify receipts sequentially; refresh never sends',async()=>{
 const {session,state,p}=fixture();await session.inspect();await session.prepare();assert.equal(state.calls.filter(c=>c.method==='eth_sendTransaction').length,0);
 for(let i=0;i<5;i++){assert.equal((await session.inspect()).index,i);await session.sendNext();const sent=state.calls.filter(c=>c.method==='eth_sendTransaction').at(-1).params[0];assert.equal(sent.to,undefined);assert.equal(sent.value,'0x0');assert.equal(sent.data,p.plan.deployments[i].data);}
 assert.equal((await session.inspect()).status,'complete');assert.equal(state.calls.filter(c=>c.method==='eth_sendTransaction').length,5);
 await assert.rejects(session.sendNext());
});
test('default existing deployment page limit remains four',()=>{
 const f=fixture();assert.throws(()=>new DeploymentSession(f.provider,f.p,f.storage,'old'));
});
test('uncertain submission blocks duplicates across reloads',async()=>{
 const f=fixture();f.state.sendError=new Error('connection lost');await assert.rejects(f.session.sendNext());assert.equal((await f.session.inspect()).status,'uncertain');
 const resumed=new DeploymentSession(f.provider,f.p,f.storage,'test',5);await assert.rejects(resumed.sendNext());assert.equal(f.state.calls.filter(c=>c.method==='eth_sendTransaction').length,1);
});
