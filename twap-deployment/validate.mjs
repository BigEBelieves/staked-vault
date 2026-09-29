// Use published compiler bytes and the previously deployed protocol manifest to
// authenticate the imported creation. The file cannot supply replacement code.
export function authenticateTwapPayload(p,build,old) {
 const relay=old.plan.addresses.relay,base=old.plan.deployments[0].args,route=old.plan.deployments[2].args[1];
 const safe=base[0],config={distributor:base[2],relay,bnkr:base[4],weth:route.weth,usdc:base[3],router:route.router,factory:'0x33128a8fC17869897dcE68Ed026d694621f6FDfD'};
 const args=[safe,config];
 const encoded=[safe,...Object.values(config)].map(a=>a.slice(2).toLowerCase().padStart(64,'0')).join('');
 const d=p.plan.deployments[0];
 if(d.data.toLowerCase()!==(build.bytecode+encoded).toLowerCase()||p.plan.safe.toLowerCase()!==safe.toLowerCase()||JSON.stringify(d.args).toLowerCase()!==JSON.stringify(args).toLowerCase())throw new Error('Creation does not match the approved keeper code and protocol destinations.');
 const values={safe,...config,paused:1n,operator:0n,nonce:0n,lastExecution:0n,spentLast24Hours:0n};
 const verification={code:build.code,immutableSlots:build.immutableSlots,calls:Object.entries(values).map(([name,v])=>({name,data:build.selectors[name],expected:'0x'+BigInt(v).toString(16).padStart(64,'0')}))};
 if(JSON.stringify(p.verification).toLowerCase()!==JSON.stringify([verification]).toLowerCase())throw new Error('Runtime verification differs from the approved build.');
 if(p.gasOracle.toLowerCase()!=='0x420000000000000000000000000000000000000f'||p.l1FeeSelector!=='0xf1c7a58b')throw new Error('Unexpected fee-estimation configuration.');
}
