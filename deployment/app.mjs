import {DeploymentSession} from './engine.mjs';
import {payloadSha256} from './payload-digest.mjs';
const $=id=>document.getElementById(id);
let provider,session,payload,busy=false,lastStatus;
const providers=[];
window.addEventListener('eip6963:announceProvider',event=>{
  if(event.detail?.info?.rdns==='io.rabby'&&!providers.includes(event.detail.provider))providers.push(event.detail.provider);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
function message(text,error=false){$('status').textContent=text;$('status').className=error?'error':'';}
function controls(){for(const button of document.querySelectorAll('button'))button.disabled=true;
 if(busy||!payload)return;
 $('connect').disabled=false;$('base').disabled=!session;$('refresh').disabled=!session;$('download').disabled=!session;
 if(lastStatus?.status==='ready')$('deploy-'+lastStatus.index).disabled=false;
 $('recover').disabled=!session||!['uncertain','recover'].includes(lastStatus?.status);
}
async function run(fn){if(busy)return;busy=true;controls();try{await fn();}catch(e){if(!['uncertain','recover','pending','confirming'].includes(lastStatus?.status))lastStatus=null;message(e.message??String(e),true);}finally{busy=false;controls();}}
function renderSteps(status){
 const rows=status?.rows??[];
 for(let i=0;i<4;i++){
  const row=rows[i];$('badge-'+i).textContent=row?.status==='verified'?'Verified on Base':row?.status==='pending'?'Pending':row?.status==='confirming'?'Confirming':i===status?.index?'Current step':'Waiting';
  const hash=session?.saved.hashes[i];const link=$('receipt-'+i);link.hidden=!hash;if(hash){link.href='https://basescan.org/tx/'+hash;link.textContent='View transaction on BaseScan';}
 }
 $('recovery').hidden=!['uncertain','recover'].includes(status?.status);
}
async function refresh(){lastStatus=await session.inspect();renderSteps(lastStatus);
 const s=lastStatus;
 if(s.status==='ready')message(`Ready for step ${s.index+1}. Click its deployment button and review the contract creation in Rabby.`);
 else if(s.status==='complete')message('All four helpers are deployed and verified. The guard remains paused and unconfigured. Download receipts and return them for verification before any Safe migration.');
 else if(s.status==='pending'||s.status==='confirming')message(`Step ${s.index+1} is ${s.status}. Wait for confirmation; the next deployment is disabled.`);
 else message('Submission status needs checking. Recover the exact transaction hash below; no automatic retry will be sent.',true);
}
async function connect(){
 provider=providers[0]??(window.ethereum?.isRabby?window.ethereum:window.ethereum?.providers?.find(p=>p.isRabby));
 if(!provider)throw new Error('Open this page on your laptop in the browser where the Rabby extension is installed.');
 await provider.request({method:'eth_requestAccounts'});
 session=new DeploymentSession(provider,payload,localStorage,'staked-deployment:'+payloadSha256);
 const changed=()=>{lastStatus=null;renderSteps(null);message('Wallet or network changed. Check progress before continuing.');controls();};
 provider.on?.('accountsChanged',changed);provider.on?.('chainChanged',changed);provider.on?.('disconnect',changed);
 await refresh();
}
async function deploy(){
 if(!navigator.locks)throw new Error('Use a current Chrome or Chromium browser for deployment locking.');
 await navigator.locks.request('staked-deployment:'+payloadSha256,{ifAvailable:true},async lock=>{
  if(!lock)throw new Error('Another tab is preparing a deployment. Finish there first.');
  message('Simulating this creation and checking wallet state before opening Rabby…');
  try {const sent=await session.sendNext();message('Submitted '+sent.hash+'. Checking the Base receipt…');await refresh();}
  catch(error){try{lastStatus=await session.inspect();renderSteps(lastStatus);}catch{}throw error;}
 });
}
function download(){const data={sourceCommit:payload.sourceCommit,deployer:payload.plan.deployer,chainId:8453,hashes:session.saved.hashes,addresses:payload.plan.addresses};
 const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'}));
 const link=document.createElement('a');link.href=url;link.download='Staked-Base-Deployment-Receipts.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
try{
 const response=await fetch('payload.json',{cache:'no-store'});if(!response.ok)throw new Error('Deployment plan could not be loaded.');
 const text=await response.text();const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
 const actual=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
 if(actual!==payloadSha256)throw new Error('Deployment files do not match. Refresh after the site finishes publishing.');
 payload=JSON.parse(text);
 $('wallet').textContent=payload.plan.deployer;$('safe').textContent=payload.plan.safe;
 $('source').href='https://github.com/BigEBelieves/staked-vault/tree/'+payload.sourceCommit;
 const titles=['Reward relay','Automation guard','Bounded buyback executor','Fee collector'];
 payload.plan.deployments.forEach((d,i)=>{
  const li=document.createElement('li');
  li.innerHTML=`<div class="stephead"><h2>${i+1}. ${titles[i]}</h2><span class="badge" id="badge-${i}">Waiting</span></div><code class="address"></code><button id="deploy-${i}" disabled>Deploy ${titles[i].toLowerCase()}</button> <a id="receipt-${i}" target="_blank" rel="noopener noreferrer" hidden></a><details><summary>Constructor and transaction details</summary><pre></pre></details>`;
  li.querySelector('.address').textContent=d.address;
  li.querySelector('pre').textContent=JSON.stringify({contract:d.name,from:d.from,nonce:d.nonce,value:'0 ETH',constructor:d.args},null,2);
  li.querySelector('button').onclick=()=>run(deploy);$('steps').append(li);
 });
 $('connect').onclick=()=>run(connect);
 $('base').onclick=()=>run(async()=>{await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x2105'}]});await refresh();});
 $('refresh').onclick=()=>run(refresh);$('download').onclick=()=>run(download);
 $('recover').onclick=()=>run(async()=>{await session.recover(lastStatus.index,$('hash').value.trim());await refresh();});
 window.addEventListener('storage',event=>{if(event.key===session?.key&&!busy)run(refresh);});
 setInterval(()=>{if(session&&!busy&&['pending','confirming'].includes(lastStatus?.status))run(refresh);},6000);
 message('Connect the deployment account in Rabby to check Base and unlock the first step.');controls();
}catch(error){message(error.message,true);payload=null;controls();}
