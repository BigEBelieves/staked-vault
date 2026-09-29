import {DeploymentSession} from '../deployment/engine.mjs';
import {authenticateTwapPayload} from './validate.mjs';
const $=id=>document.getElementById(id),providers=[];
let payload,session,provider,fingerprint,status,busy=false;
const buildPromise=Promise.all(['build.json','../deployment/payload.json'].map(async path=>{
 const r=await fetch(path,{cache:'no-store'});if(!r.ok)throw new Error('Deployment build unavailable.');return r.json();
}));
window.addEventListener('eip6963:announceProvider',e=>{if(e.detail?.info?.rdns==='io.rabby'&&!providers.includes(e.detail.provider))providers.push(e.detail.provider);});
window.dispatchEvent(new Event('eip6963:requestProvider'));
function message(text){$('status').textContent=text;}
function controls(){
 for(const id of ['connect','base','refresh','deploy','recover'])$(id).disabled=true;
 $('file').disabled=busy||!!session;
 if(busy||!payload)return;
 $('connect').disabled=false;$('base').disabled=!session;$('refresh').disabled=!session;
 $('deploy').disabled=status?.status!=='ready';$('recover').disabled=!['uncertain','recover'].includes(status?.status);
}
function render(){
 $('recovery').hidden=!['uncertain','recover'].includes(status?.status);
 const hash=session?.saved.hashes[0];$('receipt').hidden=!hash;
 if(hash)$('receipt').href='https://basescan.org/tx/'+hash;
}
async function run(fn){if(busy)return;busy=true;controls();try{await fn();}catch(e){
 if(!['uncertain','recover','pending','confirming'].includes(status?.status))status=null;
 message(e.message??String(e));
 }finally{busy=false;render();controls();}}
async function refresh(){
 status=await session.inspect();
 if(status.status==='ready')message('Ready. Click Deploy keeper, then review and approve the contract creation in Rabby.');
 else if(status.status==='complete')message('Keeper deployed and verified. It remains paused. Return the transaction hash to prepare the one-time Safe activation.');
 else if(['pending','confirming'].includes(status.status))message('Transaction '+status.status+'. Wait for verification; do not send another deployment.');
 else message('Submission status needs checking. Recover the exact creation transaction below.');
 render();
}
$('file').onchange=()=>run(async()=>{
 payload=null;status=null;$('details').hidden=true;
 const file=$('file').files[0];if(!file)return;
 if(file.size>500000)throw new Error('Unexpected deployment file size.');
 const bytes=await file.text(),p=JSON.parse(bytes);
 if(!/^[0-9a-f]{40}$/i.test(p.sourceCommit??'')||p.plan?.chainId!==8453||p.plan.deployments?.length!==1||p.verification?.length!==1||p.plan.deployments[0].name!=='StakedTwapKeeper')throw new Error('Choose the prepared single-keeper Base deployment file.');
 const d=p.plan.deployments[0];
 if(d.to!==undefined||BigInt(d.value)!==0n||d.from.toLowerCase()!==p.plan.deployer.toLowerCase())throw new Error('Unexpected creation transaction.');
 const [build,old]=await buildPromise;authenticateTwapPayload(p,build,old);
 fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bytes))),b=>b.toString(16).padStart(2,'0')).join('');
 payload=p;$('wallet').textContent=p.plan.deployer;$('safe').textContent=p.plan.safe;$('keeper').textContent=d.address;
 $('source').href='https://github.com/BigEBelieves/staked-vault/tree/'+p.sourceCommit;
 $('summary').textContent=JSON.stringify({sha256:fingerprint,nonce:d.nonce,value:'0 ETH plus gas',constructor:d.args},null,2);
 $('details').hidden=false;message('File loaded. Connect the displayed deployment wallet in Rabby.');
});
$('connect').onclick=()=>run(async()=>{
 provider=providers[0]??(window.ethereum?.isRabby?window.ethereum:window.ethereum?.providers?.find(p=>p.isRabby));
 if(!provider)throw new Error('Open this page on the laptop in the browser with the Rabby extension.');
 await provider.request({method:'eth_requestAccounts'});
 session=new DeploymentSession(provider,payload,localStorage,'staked-twap-deployment:'+fingerprint);
 const changed=()=>{status=null;message('Wallet or network changed. Check progress before continuing.');controls();};
 provider.on?.('accountsChanged',changed);provider.on?.('chainChanged',changed);provider.on?.('disconnect',changed);
 await refresh();
});
$('base').onclick=()=>run(async()=>{await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x2105'}]});await refresh();});
$('refresh').onclick=()=>run(refresh);
$('deploy').onclick=()=>run(async()=>{
 if(!navigator.locks)throw new Error('Use a current Chrome or Chromium browser for deployment locking.');
 await navigator.locks.request('staked-twap-deployment:'+fingerprint,{ifAvailable:true},async lock=>{
  if(!lock)throw new Error('Another tab is preparing this deployment.');
  message('Checking the creation, wallet nonce and gas before opening Rabby…');
  try{await session.sendNext();await refresh();}catch(e){try{status=await session.inspect();}catch{}throw e;}
 });
});
$('recover').onclick=()=>run(async()=>{await session.recover(0,$('hash').value.trim());await refresh();});
window.addEventListener('storage',e=>{if(e.key===session?.key&&!busy)run(refresh);});
setInterval(()=>{if(session&&!busy&&['pending','confirming'].includes(status?.status))run(refresh);},6000);
