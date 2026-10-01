import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pendingRequest, recoverPending} from '../web/src/pending.js';
import {connectionGate, closePairing} from '../web/src/wallet-session.js';
const account='0x'+'11'.repeat(20);
test('malformed and unavailable storage fail closed without throwing or erasing evidence',()=>{
 for(const raw of ['{','null','[]','"x"','{}',JSON.stringify({account,nonce:0,block:1})]) {
  let removed=false;
  globalThis.localStorage={getItem:()=>raw,removeItem:()=>{removed=true}};
  assert.deepEqual(pendingRequest(account),{invalid:true}); assert.equal(removed,false);
 }
 globalThis.localStorage={getItem(){throw Error('blocked')}};
 assert.deepEqual(pendingRequest(account),{invalid:true});
 globalThis.localStorage={getItem:()=>null};assert.equal(pendingRequest(account),null);
});
test('valid unresolved record is preserved',()=>{
 const r={account,to:account,data:'0x1234',nonce:0,block:1,method:'stake',hash:null};
 globalThis.localStorage={getItem:()=>JSON.stringify(r)};
 assert.deepEqual(pendingRequest(account),r);
});
test('repeated clicks and cancellation cannot overlap attempts; stale completion cannot clear the next',()=>{
 const gate=connectionGate(),one=gate.begin();assert.equal(gate.begin(),null);
 gate.cancel();assert.equal(one.cancelled,true);assert.equal(gate.begin(),null);
 gate.finish(one);const two=gate.begin();gate.finish(one);assert.equal(gate.begin(),null);gate.finish(two);assert.equal(gate.busy,false);
});
test('cleanup expires only owned proposals, removes its pairing and disconnects late session',async()=>{
 const calls=[];const wc={session:{topic:'session'},disconnect:async()=>calls.push('session'),signer:{client:{proposal:{getAll:()=>[{id:1,pairingTopic:'ours'},{id:2,pairingTopic:'other'}]},core:{expirer:{set:(id,time)=>calls.push([id,time])},pairing:{getPairings:()=>[{topic:'ours'},{topic:'other'}],disconnect:async({topic})=>calls.push(topic)}}}}};
 await closePairing(wc,'ours');assert.deepEqual(calls,[[1,0],'ours','session']);
});
test('pairing cleanup errors are observable instead of silently succeeding',async()=>{
 const wc={signer:{client:{proposal:{getAll:()=>[]},core:{pairing:{getPairings:()=>[{topic:'ours'}],disconnect:async()=>{throw Error('offline')}}}}}};
 await assert.rejects(closePairing(wc,'ours'),/offline/);
});
