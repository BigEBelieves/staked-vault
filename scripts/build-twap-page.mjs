// Public build contains generic compiler bytes/selectors only; no wallet nonce or activation plan.
import {readFileSync,writeFileSync} from 'node:fs';
import {encodeFunctionData} from 'viem';
const A=JSON.parse(readFileSync('build/all.json')).StakedTwapKeeper;
const names=['safe','distributor','relay','bnkr','weth','usdc','router','factory','paused','operator','nonce','lastExecution','spentLast24Hours'];
const artifact={bytecode:A.bytecode,code:A.deployedBytecode,immutableSlots:Object.values(A.immutableReferences).flat(),
 selectors:Object.fromEntries(names.map(functionName=>[functionName,encodeFunctionData({abi:A.abi,functionName})]))};
writeFileSync('twap-deployment/build.json',JSON.stringify(artifact)+'\n');
