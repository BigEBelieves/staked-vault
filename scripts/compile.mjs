// Compiles contracts/ + contracts/test/ with solc 0.8.24 (optimizer 200, paris) -> build/all.json
import solc from 'solc';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

const sources = {};
for (const dir of ['contracts', 'contracts/test']) {
  for (const f of readdirSync(dir)) if (f.endsWith('.sol')) sources[join(dir, f)] = { content: readFileSync(join(dir, f), 'utf8') };
}
const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);
mkdirSync('build', { recursive: true });
const all = {};
for (const file of Object.keys(out.contracts)) {
  for (const [name, c] of Object.entries(out.contracts[file])) {
    all[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object };
    writeFileSync(join('build', name + '.json'), JSON.stringify(all[name], null, 2));
  }
}
writeFileSync('build/all.json', JSON.stringify(all));
console.log('compiled:', Object.keys(all).join(', '));
console.log('solc', solc.version());
for (const n of ['StakedVault', 'StakedDistributor']) console.log(n, 'deployed bytes', (all[n].deployedBytecode.length - 2) / 2);
