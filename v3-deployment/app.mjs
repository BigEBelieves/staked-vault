import build from './build.json';
import {authenticateV3Plan} from './validate.mjs';
import {DeploymentSession,DeploymentError} from '../deployment/engine.mjs';
const $=id=>document.getElementById(id),providers=[];
let payload,session,provider,status,busy=false,fingerprint;
window.addEventListener('eip6963:announceProvider',e=>{if(e.detail?.info?.rdns==='io.rabby'&&!providers.includes(e.detail.provider))providers.push(e.detail.provider);});
window.dispatchEvent(new Event('eip6963:requestProvider'));
const message=text=>{$('status').textContent=text;};
function controls(){
 for(const id of ['connect','base','refresh','deploy','recover','export'])$(id).disabled=true;
 $('file').disabled=busy||!!session;
 if(busy||!payload)return;
 $('connect').disabled=!!session;$('base').disabled=!session;$('refresh').disabled=!session;
 $('deploy').disabled=status?.status!=='ready';$('recover').disabled=!['uncertain','recover'].includes(status?.status);$('export').disabled=!session?.saved.hashes.some(Boolean);
}
function render(){
 $('recovery').hidden=!['uncertain','recover'].includes(status?.status);
 $('contracts').replaceChildren();
 for(const [i,d]of (payload?.plan.deployments??[]).entries()){
  const li=document.createElement('li');li.textContent=`${i+1}. ${d.name} — ${d.address} — nonce ${d.nonce}`;
  const hash=session?.saved.hashes[i];if(hash){const a=document.createElement('a');a.href='https://basescan.org/tx/'+hash;a.target='_blank';a.rel='noopener noreferrer';a.textContent=' View receipt';li.append(a);}
  $('contracts').append(li);
 }
 $('deploy').textContent=status?.status==='ready'?`Deploy ${status.index+1} of 5: ${payload.plan.deployments[status.index].name}`:'Deploy next contract';
}
async function run(fn){if(busy)return;busy=true;controls();try{await fn();}catch(e){
 status=null;
 if(session){try{status=await session.inspect();}catch{}}
 // RPC errors may contain endpoints and payloads; display only our known app errors.

 message(Number(e.code)===4001?'Request declined in Rabby. No retry was sent.':e instanceof DeploymentError?e.message:'The check or wallet request did not complete. Check Rabby and refresh progress; do not resend an uncertain transaction.');
 }finally{busy=false;render();controls();}}
async function refresh(){
 status=await session.inspect();
 if(status.status==='ready')message(`Ready for contract ${status.index+1} of 5. Review its creation in Rabby; each contract requires a separate approval.`);
 else if(status.status==='complete')message('All five deployments verified. The keeper remains paused with no operator. Export receipt hashes for the separate Safe activation preparation.');
 else if(['pending','confirming'].includes(status.status))message('Transaction '+status.status+'. Wait and check progress before continuing.');
 else message('Submission needs reconciliation. Enter its exact creation transaction hash below.');
}
$('file').onchange=()=>run(async()=>{
 payload=null;status=null;
 const file=$('file').files[0];if(!file)return;if(file.size>600000)throw new DeploymentError('File is too large. Choose deployment-plan.json.');
 let p;try{p=JSON.parse(await file.text());}catch{throw new DeploymentError('Import a JSON deployment plan.');}
 payload=authenticateV3Plan(p,build);
 // Stable per-account/nonce key shared across different plan file formatting.
 fingerprint=payload.plan.deployer.toLowerCase()+':'+payload.plan.firstNonce;
 $('wallet').textContent=payload.plan.deployer;$('safe').textContent=payload.plan.safe;
 $('source').href='https://github.com/BigEBelieves/staked-vault/tree/'+build.sourceCommit;
 message('Plan matches the reviewed contracts. Connect the displayed account using Rabby on Base.');
});
$('connect').onclick=()=>run(async()=>{
 provider=providers[0]??(window.ethereum?.isRabby?window.ethereum:window.ethereum?.providers?.find(p=>p.isRabby));
 if(!provider)throw new DeploymentError('Open this page in the browser with the Rabby extension.');
 await provider.request({method:'eth_requestAccounts'});
 session=new DeploymentSession(provider,payload,localStorage,'staked-v3-deployment:'+fingerprint,5);
 const changed=()=>{status=null;message('Wallet or network changed. Check progress before continuing.');controls();};
 for(const event of ['accountsChanged','chainChanged','disconnect'])provider.on?.(event,changed);
 await refresh();
});
$('base').onclick=()=>run(async()=>{await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x2105'}]});await refresh();});
$('refresh').onclick=()=>run(refresh);
$('deploy').onclick=()=>run(async()=>{
 if(!navigator.locks)throw new DeploymentError('Use a current Chromium browser for deployment locking.');
 await navigator.locks.request('staked-v3-deployment:'+fingerprint,{ifAvailable:true},async lock=>{
  if(!lock)throw new DeploymentError('Another tab is preparing this deployment.');
  message('Checking nonce, constructor simulation and gas before opening Rabby…');await session.sendNext();await refresh();
 });
});
$('recover').onclick=()=>run(async()=>{await session.recover(status.index,$('hash').value.trim());await refresh();});
$('export').onclick=()=>{
 const blob=new Blob([JSON.stringify(session.saved.hashes,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download='staked-v3-deployment-hashes.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
window.addEventListener('storage',e=>{if(e.key===session?.key&&!busy)run(refresh);});
setInterval(()=>{if(session&&!busy&&['pending','confirming'].includes(status?.status))run(refresh);},6000);
controls();
