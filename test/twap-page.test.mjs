import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {encodeFunctionData,encodeFunctionResult} from 'viem';
import {createTwapDeployment} from '../scripts/twap-deployment.mjs';
import {authenticateTwapPayload} from '../twap-deployment/validate.mjs';
const load=p=>JSON.parse(readFileSync(p));
const A=load('build/all.json'),old=load('deployment/payload.json'),build=load('twap-deployment/build.json'),H=old.plan.addresses;
const C={...load('config/base.json'),relay:H.relay,factory:'0x33128a8fC17869897dcE68Ed026d694621f6FDfD'};
function fixture(){
 const plan=createTwapDeployment(C,A,'0x'+'ab'.repeat(20),10);
 const expected={safe:C.safe,...plan.deployments[0].args[1],paused:true,operator:'0x'+'00'.repeat(20),nonce:0n,lastExecution:0,spentLast24Hours:0n};
 return {plan,gasOracle:old.gasOracle,l1FeeSelector:old.l1FeeSelector,verification:[{code:A.StakedTwapKeeper.deployedBytecode,immutableSlots:Object.values(A.StakedTwapKeeper.immutableReferences).flat(),
  calls:Object.entries(expected).map(([name,result])=>({name,data:encodeFunctionData({abi:A.StakedTwapKeeper.abi,functionName:name}),expected:encodeFunctionResult({abi:A.StakedTwapKeeper.abi,functionName:name,result})}))}]};
}
test('single-helper file matches published compiler bytes and existing protocol manifest',()=>{
 authenticateTwapPayload(fixture(),build,old);
 assert.equal(build.bytecode,A.StakedTwapKeeper.bytecode);
 assert.equal(build.code,A.StakedTwapKeeper.deployedBytecode);
});
test('import cannot substitute creation code, Safe, router, runtime verification or gas oracle',()=>{
 for(const mutate of [p=>p.plan.deployments[0].data='0x00',p=>p.plan.safe='0x'+'99'.repeat(20),
  p=>p.plan.deployments[0].args[1].router='0x'+'99'.repeat(20),p=>p.verification[0].code='0x00',
  p=>p.verification[0].calls[0].expected='0x00',p=>p.verification[0].immutableSlots=[],
  p=>p.gasOracle='0x'+'99'.repeat(20),p=>p.l1FeeSelector='0x00000000']) {
  const p=fixture();mutate(p);assert.throws(()=>authenticateTwapPayload(p,build,old));
 }
});
