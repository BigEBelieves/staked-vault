# V3 vault source verification — 2026-10-01

Contract: `0x6e6c236d5ef18caf835faf2bd495ed48e3f8ccc5`, Base 8453.
Creation transaction: `0x33a749aa0d3110d2bc2eb0bdb8fb449c87cf04f5a12ec443b254f301c0c5c0d9`.
Deployment build recorded source revision `19210c9d613665a0fcb1615a4e41436fdf2f90c1`.
Recompiled source in the skill branch at `9c3103caffed9fbd712867f55cf3c3e79369e5a8`; full creation input matches the saved deployment plan and live transaction, including constructor arguments.

## Result

Sourcify verification job `c235e2c7-0e9c-450e-9aed-25b6424d6804` completed at 2026-10-01 13:32:59 UTC with exact creation and runtime matches (match ID 54476024). `result.json` records the response. Etherscan forwarding hit a 3/sec rate limit, Blockscout forwarding returned 429. BaseScan verification is not yet complete. This is source verification, not an audit or proof of Bankr scanner acceptance.

API evidence: https://sourcify.dev/server/v2/verify/c235e2c7-0e9c-450e-9aed-25b6424d6804
Contract lookup: https://sourcify.dev/server/v2/contract/8453/0x6e6c236d5ef18caf835faf2bd495ed48e3f8ccc5

## BaseScan package

Choose Solidity (Standard-Json-Input), compiler `v0.8.24+commit.e11b9ed9`, MIT license. Upload `standard-input.json`. Compiler settings inside it: optimizer enabled, 200 runs, EVM paris. Target `contracts/StakedVaultV3.sol:StakedVaultV3`. Constructor ABI bytes (without 0x) are in `constructor-arguments.txt`.

The cloud browser form is prepared with address/compiler/license. It requires acceptance of BaseScan terms of service before proceeding; that has NOT been accepted by the assistant. No wallet signature is required for source publication.

## Blocked approval

User reports Bankr rejected the 100-STAKED approval with `unverified_contract` and no hash. Its journal operation `op-b04e97b118249666141732649f288dc6-approve` remains UNKNOWN. No transaction was submitted by this verification work and no journal was cleared. Nonce equality, unchanged allowance and an empty activity list alone do not resolve an uncertain submission. Source verification does not establish non-broadcast or authorize a retry. Obtain authoritative pre-broadcast rejection evidence or reconcile the original execution before a new separately authorized attempt. Do not bypass the scanner or change submission tools to evade it.
