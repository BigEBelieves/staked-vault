// Browser-side deployment only. Every send requires an explicit user click and wallet approval.
export const hex = value => '0x'+BigInt(value).toString(16);
const same = (a,b) => typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const requireThat = (condition,message) => { if(!condition) throw new Error(message); };
const isHash = value => /^0x[0-9a-f]{64}$/i.test(value??'');
const ZERO_CODE = value => !value || value==='0x';
export function checkRuntime(code,artifact) {
  requireThat(typeof code==='string' && code.length===artifact.code.length,'Deployed code has an unexpected length. Stop.');
  const mask = input => {
    const chars=input.toLowerCase().split('');
    for(const {start,length} of artifact.immutableSlots) chars.fill('0',2+start*2,2+(start+length)*2);
    return chars.join('');
  };
  requireThat(mask(code)===mask(artifact.code),'Deployed code does not match this build. Stop.');
}
export class DeploymentSession {
  constructor(provider,payload,storage,key) {
    this.provider=provider;this.payload=payload;this.storage=storage;this.key=key;this.inFlight=false;
    this.count=payload.plan.deployments.length;
    requireThat(this.count>0&&this.count<=4&&payload.verification.length===this.count,'Invalid deployment count.');
    this.load();
  }
  rpc(method,params=[]) {return this.provider.request({method,params});}
  load() {
    const raw=this.storage.getItem(this.key);
    this.saved=raw?JSON.parse(raw):{hashes:Array(this.count).fill(null),uncertain:Array(this.count).fill(false)};
    requireThat(Array.isArray(this.saved.hashes)&&this.saved.hashes.length===this.count&&this.saved.hashes.every(h=>h===null||isHash(h)), 'Saved receipt data is invalid. Stop and inspect it.');
    requireThat(Array.isArray(this.saved.uncertain)&&this.saved.uncertain.length===this.count&&this.saved.uncertain.every(v=>typeof v==='boolean'),'Saved transaction status is invalid.');
  }
  save() {this.storage.setItem(this.key,JSON.stringify(this.saved));}
  async identity() {
    requireThat(BigInt(await this.rpc('eth_chainId'))===8453n,'Select Base in Rabby, then check again.');
    const accounts=await this.rpc('eth_accounts');
    requireThat(same(accounts[0],this.payload.plan.deployer),'Select the deployment account shown on this page in Rabby.');
    requireThat(ZERO_CODE(await this.rpc('eth_getCode',[this.payload.plan.deployer,'latest'])),'This account now has delegated or contract code. Stop and regenerate the deployment plan.');
  }
  async verifyOne(index,hash,head) {
    const d=this.payload.plan.deployments[index];
    const receipt=await this.rpc('eth_getTransactionReceipt',[hash]);
    if(!receipt)return {status:'pending',hash};
    requireThat(BigInt(receipt.status)===1n,`${d.name} reverted. The nonce was consumed; stop and regenerate the plan.`);
    requireThat(same(receipt.contractAddress,d.address),'Unexpected deployed address. Stop.');
    const tx=await this.rpc('eth_getTransactionByHash',[hash]);
    requireThat(tx&&tx.to===null&&same(tx.from,d.from)&&BigInt(tx.nonce)===BigInt(d.nonce)&&BigInt(tx.value)===0n&&same(tx.input??tx.data,d.data),'Receipt does not belong to the exact planned creation. Stop.');
    if(tx.chainId!==undefined)requireThat(BigInt(tx.chainId)===8453n,'Receipt is on the wrong chain.');
    const canonical=await this.rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
    requireThat(canonical&&same(canonical.hash,receipt.blockHash),'Receipt is not in the current chain. Wait and check again.');
    if(BigInt(head.number)<BigInt(receipt.blockNumber)+1n)return {status:'confirming',hash};
    const artifact=this.payload.verification[index];
    checkRuntime(await this.rpc('eth_getCode',[d.address,head.number]),artifact);
    for(const check of artifact.calls) {
      const result=await this.rpc('eth_call',[{to:d.address,data:check.data},head.number]);
      requireThat(same(result,check.expected),`${d.name}: ${check.name} does not match. Stop.`);
    }
    return {status:'verified',hash,address:d.address};
  }
  async inspect() {
    this.load();await this.identity();
    const head=await this.rpc('eth_getBlockByNumber',['latest',false]);
    const rows=[];
    for(let i=0;i<this.count;i++) {
      const hash=this.saved.hashes[i];
      if(hash) {
        const row=await this.verifyOne(i,hash,head);rows.push(row);
        if(row.status!=='verified')return {status:row.status,index:i,rows,head};
      } else {
        requireThat(!this.saved.hashes.slice(i+1).some(Boolean),'Saved transactions are out of order. Stop.');
        if(this.saved.uncertain[i])return {status:'uncertain',index:i,rows,head};
        const d=this.payload.plan.deployments[i];
        const code=await this.rpc('eth_getCode',[d.address,head.number]);
        if(!ZERO_CODE(code))return {status:'recover',index:i,rows,head};
        const [latest,pending]=await Promise.all(['latest','pending'].map(tag=>this.rpc('eth_getTransactionCount',[d.from,tag])));
        requireThat(BigInt(latest)===BigInt(d.nonce)&&BigInt(pending)===BigInt(d.nonce),'The wallet nonce changed or a transaction is pending. Stop; this plan needs checking.');
        return {status:'ready',index:i,rows,head};
      }
    }
    return {status:'complete',index:this.count,rows,head};
  }
  async prepare() {
    const status=await this.inspect();requireThat(status.status==='ready','Complete or recover the current step before requesting another transaction.');
    const d=this.payload.plan.deployments[status.index];
    const call={from:d.from,data:d.data,value:'0x0',nonce:hex(d.nonce)};
    // A creation eth_call returns the deployed runtime. Check it before opening a signing request.
    checkRuntime(await this.rpc('eth_call',[{...call,gas:hex(12000000)},'latest']),this.payload.verification[status.index]);
    const estimated=BigInt(await this.rpc('eth_estimateGas',[call]));
    const gas=(estimated*120n+99n)/100n;
    requireThat(gas>0n&&gas<=12000000n,'Unexpected deployment gas estimate. Stop.');
    const price=BigInt(await this.rpc('eth_gasPrice'));
    requireThat(price>0n,'Invalid gas-price response.');
    const maxFeePerGas=price*2n;
    const priority=BigInt(await this.rpc('eth_maxPriorityFeePerGas'));
    requireThat(priority>=0n&&priority<=maxFeePerGas,'Priority fee exceeds the prepared fee cap. Recheck later.');
    const dataSize=BigInt((d.data.length-2)/2+200);
    const l1Data=this.payload.l1FeeSelector+dataSize.toString(16).padStart(64,'0');
    const l1Fee=BigInt(await this.rpc('eth_call',[{to:this.payload.gasOracle,data:l1Data},'latest']));
    const balance=BigInt(await this.rpc('eth_getBalance',[d.from,'latest']));
    requireThat(balance>=gas*maxFeePerGas+l1Fee,'Insufficient ETH on Base for the current gas budget.');
    // Recheck identity, nonce, and prior receipts after the simulations and fee reads.
    const fresh=await this.inspect();
    requireThat(fresh.status==='ready'&&fresh.index===status.index,'Wallet state changed during preparation. Check again.');
    return {index:status.index,gasBudget:gas*maxFeePerGas+l1Fee,
      transaction:{...call,chainId:'0x2105',gas:hex(gas),maxFeePerGas:hex(maxFeePerGas),maxPriorityFeePerGas:hex(priority)}};
  }
  async sendNext() {
    requireThat(!this.inFlight,'A wallet request is already open.');this.inFlight=true;
    let index;
    try {
      const prepared=await this.prepare();index=prepared.index;
      this.saved.uncertain[index]=true;this.save(); // Durable marker before invoking the wallet.
      const hash=await this.rpc('eth_sendTransaction',[prepared.transaction]);
      requireThat(isHash(hash),'The wallet did not return a transaction hash. Inspect Rabby before continuing.');
      this.saved.hashes[index]=hash;this.saved.uncertain[index]=false;this.save();
      return {index,hash};
    } catch(error) {
      // Only an explicit user rejection is safe to retry. RPC/disconnect errors may occur after broadcast.
      if(index!==undefined&&Number(error.code)===4001){this.saved.uncertain[index]=false;this.save();}
      throw error;
    } finally {this.inFlight=false;}
  }
  async recover(index,hash) {
    requireThat(Number.isInteger(index)&&index>=0&&index<this.count&&isHash(hash),'Enter the complete Base transaction hash.');
    this.load();await this.identity();
    const head=await this.rpc('eth_getBlockByNumber',['latest',false]);
    const verified=await this.verifyOne(index,hash,head);
    requireThat(verified.status==='verified','The supplied transaction must be confirmed and verified before recovery.');
    this.saved.hashes[index]=hash;this.saved.uncertain[index]=false;this.save();
    return verified;
  }
}
