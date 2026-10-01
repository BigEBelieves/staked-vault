// Served only by the browser test route in place of the bundled SDK.
export const EthereumProvider = {async init() {
 const state = window.wcTest ||= {inits:0,enables:0,active:0,maxActive:0,removed:0,disconnected:0};
 state.inits++;
 if (state.delayInit) await new Promise(r=>{state.releaseInit=r});
 const events = new Map();let reject,resolve;
 const topic = 'a'.repeat(63)+state.inits;let pairing=false,proposal=false;
 const wc={on:(n,f)=>events.set(n,f),removeListener:(n)=>events.delete(n),
 request:async payload=>{const r=await window.__testRpc(payload);if(r.error)throw r.error;return r.result;},
 async enable(){state.enables++;state.active++;state.maxActive=Math.max(state.maxActive,state.active);
  pairing=true;proposal=true;
  const pending=new Promise((a,b)=>{resolve=a;reject=b});
  state.approve=()=>{wc.session={topic:'session'};proposal=false;resolve(['0x'+'11'.repeat(20)]);};
  events.get('display_uri')?.('wc:'+topic+'@2?relay-protocol=irn&symKey='+ '1'.repeat(64));
  try{return await pending;}finally{state.active--;}
 },async disconnect(){state.disconnected++;wc.session=null;},
 signer:{client:{proposal:{getAll:()=>proposal?[{id:1,pairingTopic:topic}]:[]},core:{
 expirer:{set:()=>{proposal=false;queueMicrotask(()=>reject(Error('cancelled')));}},
 pairing:{getPairings:()=>pairing?[{topic}]:[],disconnect:async()=>{if(state.failCleanup)throw Error('offline');pairing=false;state.removed++;}}
 }}}};state.wc=wc;return wc;
}};
