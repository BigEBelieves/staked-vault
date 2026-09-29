import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeDeployData, getContractAddress } from 'viem';
import { createDeploymentPlan, validatePlan, assertRuntime, safeChecksum } from '../scripts/deployment-plan.mjs';
const C = JSON.parse(readFileSync('config/base.json'));
const A = JSON.parse(readFileSync('build/all.json'));
const deployer = '0x0000000000000000000000000000000000001234';
const plan = createDeploymentPlan(C,A,deployer,7);
test('direct CREATE plan binds constructors to Safe and predicted guard', () => {
  for (const [i,d] of plan.deployments.entries()) {
    assert.equal(d.address,getContractAddress({from:deployer,nonce:7n+BigInt(i)}));
    assert.equal(d.to,undefined);
    const decoded=decodeDeployData({abi:A[d.name].abi,bytecode:A[d.name].bytecode,data:d.data});
    assert.equal(decoded.args[0].toLowerCase(),C.safe);
    if (i===2) assert.equal(decoded.args[1].guard.toLowerCase(),plan.addresses.guard.toLowerCase());
  }
});
test('manifest rejects changed Safe or constructor calldata', () => {
  for (const edit of [p=>p.safe=deployer,p=>p.deployments[0].data+='00',p=>p.deployments[1].nonce++]) {
    const p=structuredClone(plan);edit(p);
    assert.throws(()=>validatePlan(C,A,p),/Plan differs/);
  }
});
test('manifest rejects a changed build or config', () => {
  assert.throws(()=>validatePlan({...C,vault:deployer},A,plan),/Plan differs/);
  const artifacts=structuredClone(A);artifacts.StakedFeeCollector.bytecode+='00';
  assert.throws(()=>validatePlan(C,artifacts,plan),/Plan differs/);
});
test('nonce and chain validation reject unsafe inputs', () => {
  for (const nonce of [-1,Number.MAX_SAFE_INTEGER]) assert.throws(()=>createDeploymentPlan(C,A,deployer,nonce),/Invalid nonce/);
  assert.throws(()=>createDeploymentPlan({...C,chainId:1},A,deployer,0),/Base only/);
});
test('runtime comparison detects altered executable code and missing deployments', () => {
  const a=A.StakedAutomationGuard;
  assertRuntime(a,a.deployedBytecode,'guard');
  assert.throws(()=>assertRuntime(a,'0x','guard'),/Missing deployed code/);
  assert.throws(()=>assertRuntime(a,'0xff'+a.deployedBytecode.slice(4),'guard'),/Runtime mismatch/);
  assert.throws(()=>assertRuntime(a,a.deployedBytecode+'00','guard'),/Wrong runtime length/);
});
test('only compiler-designated immutable slots are masked', () => {
  const a=A.StakedAutomationGuard;
  const bytes=Buffer.from(a.deployedBytecode.slice(2),'hex');
  const refs=Object.values(a.immutableReferences).flat();
  assert(refs.length>0);
  for (const {start,length} of refs) bytes.fill(1,start,start+length);
  assertRuntime(a,'0x'+bytes.toString('hex'),'guard');
});
test('Safe checksum matches previously imported ownership batch', () => {
  const batch={version:'1.0',chainId:'8453',createdAt:1790643720000,meta:{
    name:'Staked Vault - accept ownership of three contracts',
    description:'Execute from Base Safe 0xb9066550918fa778a4039120eac878230cf8f6FC only after all three contracts report this Safe as pendingOwner. Calls acceptOwnership() on the vault, distributor and executor. Each call sends 0 ETH. This file does not initiate transfers or change keeper, payout, token allowance or swap settings.',
    createdFromSafeAddress:'0xb9066550918fa778a4039120eac878230cf8f6FC',createdFromOwnerAddress:''},
    transactions:['0x01b568eBCFb8c6db2Cf1c5f70c9b105f4187D92F','0xDdf0eC9aA4d36eD07257187b524a8810c5BCF376','0x290072cF64963D469a6be9d124D7328bf2992755'].map(to=>({
      to,value:'0',data:'0x79ba5097',contractMethod:{inputs:[],name:'acceptOwnership',payable:false},contractInputsValues:{}}))};
  const checksum=safeChecksum(batch);
  assert.equal(checksum,'0xdd98a0ffce11e120291cb300888a00cbcdbe756c656fa1e987f71ef5f42093af');
  batch.meta.checksum=checksum;
  assert.equal(safeChecksum(batch),checksum);
  batch.transactions.reverse();
  assert.notEqual(safeChecksum(batch),checksum);
});
