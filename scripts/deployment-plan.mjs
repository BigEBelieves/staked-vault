// Read-only preparation. This module has no wallet client, signing, or broadcast path.
import assert from 'node:assert/strict';
import { encodeDeployData, encodeFunctionData, getContractAddress, isAddress, keccak256, parseAbi } from 'viem';

export const ZERO = '0x' + '0'.repeat(40);
export const OTHER_BENEFICIARY = '0x21e2ce70511e4fe542a97708e89520471daa7a66';
const SHARE = 950000000000000000n;
const MULTISEND_HASH = '0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939';
export const feeAbi = parseAbi(['function collectFees(bytes32) returns(uint128,uint128)',
  'function updateBeneficiary(bytes32,address)', 'function getShares(bytes32,address) view returns(uint256)']);
const safeAbi = parseAbi(['function getOwners() view returns(address[])', 'function getThreshold() view returns(uint256)',
  'function nonce() view returns(uint256)']);
const allowanceAbi = parseAbi(['function allowance(address,address) view returns(uint256)']);
const equal = (a,b,label) => assert.equal(typeof a === 'string' ? a.toLowerCase() : a,
  typeof b === 'string' ? b.toLowerCase() : b, label);
export const json = value => JSON.stringify(value, (_,v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';

// Safe Transaction Builder's published checksum format (not ordinary JSON.stringify):
// https://github.com/safe-global/safe-react-apps/blob/main/apps/tx-builder/src/lib/checksum.ts
export function safeChecksum(batch) {
  function serialize(value) {
    if (Array.isArray(value)) return '['+value.map(serialize).join(',')+']';
    if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value).sort();
      return '{'+JSON.stringify(keys)+keys.map(key=>serialize(value[key])+',').join('')+'}';
    }
    return JSON.stringify(value === undefined ? null : value);
  }
  const meta = {...batch.meta,name:null};
  delete meta.checksum;
  return keccak256(new TextEncoder().encode(serialize({...batch,meta})));
}

export function createDeploymentPlan(C, A, deployer, firstNonce) {
  assert.equal(C.chainId, 8453, 'Base only');
  assert(isAddress(deployer) && deployer.toLowerCase() !== ZERO, 'Invalid deployer');
  const nonce = BigInt(firstNonce);
  assert(nonce >= 0n && nonce + 3n <= BigInt(Number.MAX_SAFE_INTEGER), 'Invalid nonce');
  const names = ['StakedRewardRelay','StakedAutomationGuard','StakedBoundedBuybackExecutor','StakedFeeCollector'];
  const addresses = Object.fromEntries(['relay','guard','executor','collector'].map((key,i) =>
    [key,getContractAddress({from:deployer,nonce:nonce+BigInt(i)})]));
  const config = {vault:C.vault,guard:addresses.guard,usdc:C.usdc,weth:C.weth,bnkr:C.bnkr,staked:C.staked,
    router:C.v3Router,poolManager:C.poolManager,feeUsdcWeth:C.feeUsdcWeth,feeWethBnkr:C.feeWethBnkr,
    v4Fee:C.poolKey.fee,tickSpacing:C.poolKey.tickSpacing,hooks:C.initializer};
  const args = [[C.safe,C.vault,C.distributor,C.usdc,C.bnkr], [C.safe,C.vault,C.distributor],
    [C.safe,config], [C.safe,C.initializer,C.poolId,C.staked,C.bnkr,C.distributor]];
  const deployments = names.map((name,i) => ({name,address:Object.values(addresses)[i],
    nonce:Number(nonce+BigInt(i)),chainId:C.chainId,from:deployer.toLowerCase(),value:'0',args:args[i],
    // Omit `to`: these MUST be direct contract-creation transactions, never calls to a factory.
    data:encodeDeployData({abi:A[name].abi,bytecode:A[name].bytecode,args:args[i]})}));
  return {version:1,chainId:C.chainId,safe:C.safe,deployer:deployer.toLowerCase(),firstNonce:nonce.toString(),
    mode:'unsigned direct CREATE; predicted addresses are not deployed addresses',addresses,deployments};
}

export function validatePlan(C,A,plan) {
  const expected = createDeploymentPlan(C,A,plan.deployer,plan.firstNonce);
  assert.deepEqual(plan,expected,'Plan differs from this checkout/config/compiler; regenerate and review');
  return expected;
}

// Solidity patches immutable values into runtime code. Constructor transaction checks and getter
// checks below authenticate those values; all remaining runtime bytes must match exactly.
export function assertRuntime(artifact,code,label) {
  assert(code && code !== '0x','Missing deployed code: '+label);
  equal(code.length,artifact.deployedBytecode.length,'Wrong runtime length: '+label);
  const mask = hex => {
    const bytes = Buffer.from(hex.slice(2),'hex');
    for (const refs of Object.values(artifact.immutableReferences ?? {})) for (const {start,length} of refs)
      bytes.fill(0,start,start+length);
    return bytes.toString('hex');
  };
  equal(mask(code),mask(artifact.deployedBytecode),'Runtime mismatch: '+label);
}

export async function verifyDeployments(client,C,A,plan,hashes) {
  validatePlan(C,A,plan);
  equal(await client.getChainId(),C.chainId,'Wrong chain');
  assert(Array.isArray(hashes) && hashes.length === 4 && new Set(hashes).size === 4,'Four distinct deployment hashes required');
  const block = await client.getBlock();
  const read = (address,abi,functionName,args=[]) => client.readContract({address,abi,functionName,args,blockNumber:block.number});
  const receipts = [];
  for (let i=0;i<4;i++) {
    const d = plan.deployments[i];
    const [tx,receipt,code] = await Promise.all([client.getTransaction({hash:hashes[i]}),
      client.getTransactionReceipt({hash:hashes[i]}),client.getBytecode({address:d.address,blockNumber:block.number})]);
    equal(receipt.status,'success','Deployment reverted: '+d.name);
    assert(receipt.blockNumber <= block.number,'Deployment newer than snapshot');
    equal((await client.getBlock({blockNumber:receipt.blockNumber})).hash,receipt.blockHash,'Deployment is not canonical');
    equal(tx.to,null,'Deployment must be direct CREATE');
    equal(tx.from,plan.deployer,'Wrong deployment sender');
    equal(tx.nonce,d.nonce,'Wrong deployment nonce');
    equal(tx.value,0n,'Unexpected deployment value');
    equal(tx.input,d.data,'Wrong constructor bytecode or arguments');
    equal(receipt.contractAddress,d.address,'Wrong deployed address');
    assertRuntime(A[d.name],code,d.name);
    receipts.push({name:d.name,address:d.address,hash:hashes[i],block:receipt.blockNumber.toString(),runtimeHash:keccak256(code)});
  }
  const H = plan.addresses;
  const checks = [
    ['StakedRewardRelay',H.relay,{safe:C.safe,vault:C.vault,distributor:C.distributor,usdc:C.usdc,bnkr:C.bnkr}],
    ['StakedAutomationGuard',H.guard,{safe:C.safe,vault:C.vault,distributor:C.distributor}],
    ['StakedBoundedBuybackExecutor',H.executor,{safe:C.safe,vault:C.vault,guard:H.guard,usdc:C.usdc,weth:C.weth,
      bnkr:C.bnkr,staked:C.staked,router:C.v3Router,poolManager:C.poolManager,feeUsdcWeth:C.feeUsdcWeth,
      feeWethBnkr:C.feeWethBnkr,bnkrIsCurrency0:BigInt(C.bnkr)<BigInt(C.staked)}],
    ['StakedFeeCollector',H.collector,{safe:C.safe,initializer:C.initializer,poolId:C.poolId,staked:C.staked,bnkr:C.bnkr,distributor:C.distributor}]
  ];
  for (const [name,address,values] of checks) for (const [key,value] of Object.entries(values))
    equal(await read(address,A[name].abi,key),value,`${name}.${key}`);
  const pool = await read(H.executor,A.StakedBoundedBuybackExecutor.abi,'poolKey');
  [C.poolKey.currency0,C.poolKey.currency1,C.poolKey.fee,C.poolKey.tickSpacing,C.poolKey.hooks].forEach((v,i) => equal(pool[i],v,'Pool key'));
  equal((await client.getBlock({blockNumber:block.number})).hash,block.hash,'Snapshot reorg; retry');
  return {block,receipts,read};
}

export async function prepareSafeBatch(client,C,A,plan,hashes,stage) {
  assert(['wire','fees','operator','rollback'].includes(stage),'Unknown stage');
  const {block,receipts,read} = await verifyDeployments(client,C,A,plan,hashes);
  const H = plan.addresses;
  const owners = await read(C.safe,safeAbi,'getOwners');
  equal(owners.length,3,'Expected three Safe owners');
  equal(await read(C.safe,safeAbi,'getThreshold'),2n,'Expected 2-of-3 Safe');
  assert(!owners.some(o => o.toLowerCase() === C.bankr),'Bankr must not be a Safe signer');
  const safeNonce = await read(C.safe,safeAbi,'nonce');
  equal(keccak256(await client.getBytecode({address:C.multiSendCallOnly,blockNumber:block.number})),MULTISEND_HASH,'Wrong MultiSend code');
  const call = (name,address,fn,args=[]) => read(address,A[name].abi,fn,args);
  for (const [name,address] of [['StakedVault',C.vault],['StakedDistributor',C.distributor],['StakedBuybackExecutor',C.legacyExecutor]]) {
    equal(await call(name,address,'owner'),C.safe,name+' owner');
    equal(await call(name,address,'pendingOwner'),ZERO,name+' pending owner');
  }
  const shares = {};
  for (const [name,address] of [['safe',C.safe],['bankr',C.bankr],['collector',H.collector],['other',OTHER_BENEFICIARY]])
    shares[name] = await read(C.initializer,feeAbi,'getShares',[C.poolId,address]);
  equal(shares.bankr,0n,'Bankr fee rights');
  equal(shares.other,50000000000000000n,'Other beneficiary share changed');
  if (stage !== 'rollback') {
    equal(shares.safe,stage==='operator'?0n:SHARE,stage==='operator'?'Fee migration must be complete':'Safe must still own 95% before this stage');
    equal(shares.collector,stage==='operator'?SHARE:0n,stage==='operator'?'Collector must own 95%':'Collector already owns fees');
    equal(await call('StakedAutomationGuard',H.guard,'paused'),true,'Guard must remain paused');
    equal(await call('StakedAutomationGuard',H.guard,'operator'),ZERO,'Operator must remain disabled');
    for (const fn of ['remainingBnkr','remainingUsdc']) equal(await call('StakedAutomationGuard',H.guard,fn),0n,'No active budget');
    for (const fn of ['liquidityWallet','bnkrStakingWallet']) equal(await call('StakedDistributor',C.distributor,fn),C.safe,fn);
    for (const [token,spender] of [[C.staked,C.distributor],[C.bnkr,C.distributor],[C.bnkr,C.vault]])
      equal(await read(token,allowanceAbi,'allowance',[C.bankr,spender]),0n,'Bankr allowance');
    for (const [fn,value] of Object.entries({swapRouter:C.v3Router,bnkrWethFee:C.feeWethBnkr,wethUsdcFee:C.feeUsdcWeth}))
      equal(await call('StakedDistributor',C.distributor,fn),value,'Distributor route changed');
    if (stage === 'wire') {
      equal(await call('StakedAutomationGuard',H.guard,'nonce'),0n,'Guard was already configured');
      equal(await call('StakedAutomationGuard',H.guard,'executor'),ZERO,'Guard executor already set');
      equal(await call('StakedVault',C.vault,'buybackExecutor'),C.legacyExecutor,'Existing executor changed');
    } else {
      equal(await call('StakedAutomationGuard',H.guard,'executor'),H.executor,'Guard executor mismatch');
      equal(await call('StakedVault',C.vault,'buybackExecutor'),H.executor,'Vault executor mismatch');
    }
    equal(await call('StakedVault',C.vault,'keeper'),stage==='wire'?ZERO:H.guard,'Vault keeper mismatch');
    equal(await call('StakedDistributor',C.distributor,'keeper'),stage==='wire'?ZERO:H.guard,'Distributor keeper mismatch');
    equal(await call('StakedVault',C.vault,'distributor'),stage==='wire'?C.distributor:H.relay,'Vault relay mismatch');
    equal(await call('StakedDistributor',C.distributor,'vault'),stage==='wire'?C.vault:H.relay,'Distributor relay mismatch');
  } else assert((shares.safe===SHARE && shares.collector===0n) || (shares.safe===0n && shares.collector===SHARE),'Unexpected fee ownership');

  const transactions = [];
  const add = (name,to,fn,args=[]) => transactions.push({to,value:'0',data:encodeFunctionData({abi:A[name].abi,functionName:fn,args})});
  if (stage === 'wire') {
    add('StakedVault',C.vault,'setKeeper',[ZERO]);
    add('StakedDistributor',C.distributor,'setKeeper',[ZERO]);
    add('StakedAutomationGuard',H.guard,'setExecutor',[H.executor]);
    add('StakedDistributor',C.distributor,'setVault',[H.relay]);
    add('StakedVault',C.vault,'setDistributor',[H.relay]);
    add('StakedVault',C.vault,'setBuybackExecutor',[H.executor]);
    add('StakedVault',C.vault,'setKeeper',[H.guard]);
    add('StakedDistributor',C.distributor,'setKeeper',[H.guard]);
    add('StakedDistributor',C.distributor,'setLiquidityWallet',[C.safe]);
    add('StakedDistributor',C.distributor,'setBnkrStakingWallet',[C.safe]);
  } else if (stage === 'fees') {
    for (const [functionName,args] of [['collectFees',[C.poolId]],['updateBeneficiary',[C.poolId,H.collector]]])
      transactions.push({to:C.initializer,value:'0',data:encodeFunctionData({abi:feeAbi,functionName,args})});
  } else if (stage === 'operator') {
    // Configuration only: no policy, budget, unpause, swap, approval or token transfer.
    add('StakedAutomationGuard',H.guard,'setOperator',[C.bankr]);
  } else {
    add('StakedAutomationGuard',H.guard,'setPaused',[true]);
    add('StakedAutomationGuard',H.guard,'setOperator',[ZERO]);
    add('StakedVault',C.vault,'setKeeper',[ZERO]);
    add('StakedDistributor',C.distributor,'setKeeper',[ZERO]);
    if (shares.collector===SHARE) add('StakedFeeCollector',H.collector,'returnBeneficiaryToSafe');
    add('StakedDistributor',C.distributor,'setVault',[C.vault]);
    add('StakedVault',C.vault,'setDistributor',[C.distributor]);
  }
  equal((await client.getBlock({blockNumber:block.number})).hash,block.hash,'Snapshot reorg; retry');
  const batch = {version:'1.0',chainId:String(C.chainId),createdAt:Number(block.timestamp)*1000,
    meta:{name:`STAKED ${stage} — review before signing`,description:`Base snapshot ${block.number}; Safe nonce observed ${safeNonce}. Recheck state and simulate before signing.`,
      createdFromSafeAddress:C.safe,createdFromOwnerAddress:''},transactions};
  batch.meta.checksum = safeChecksum(batch);
  return {batch,verification:{stage,block:block.number.toString(),blockHash:block.hash,timestamp:block.timestamp.toString(),
    safe:C.safe,safeNonce:safeNonce.toString(),owners,shares,deployments:receipts,
    batchHash:keccak256(new TextEncoder().encode(json(batch)))}};
}
