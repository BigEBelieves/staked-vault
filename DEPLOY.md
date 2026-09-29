# Base deployment

## Existing non-upgradeable contracts

| Contract | Address |
|---|---|
| Vault | `0x01b568eBCFb8c6db2Cf1c5f70c9b105f4187D92F` |
| Distributor | `0xDdf0eC9aA4d36eD07257187b524a8810c5BCF376` |
| Legacy executor | `0x290072cF64963D469a6be9d124D7328bf2992755` |
| Owner Safe | `0xb9066550918fa778a4039120eac878230cf8f6FC` |

Original deployment: September 28, 2026. Compiler: solc 0.8.24, optimizer 200, EVM Paris.
The Safe ownership and fee-beneficiary migration supersede the original Bankr-owned setup.
Re-read ownership, keepers, payouts, Safe threshold and beneficiary shares before any transaction.
Known addresses and pool parameters are in [config/base.json](config/base.json).

## Fork verification

The recorded integration run passed 60 checks against Base block 51,929,714, including actual
Safe execution, fee collection, v3/v4 swaps and rollback. See [FORK-TESTING.md](FORK-TESTING.md).
The helpers remain undeployed; fresh-state simulation and independent review are still required.

## Proposed helpers — not deployed

Follow [SECURITY-MIGRATION.md](SECURITY-MIGRATION.md), including fork tests, constructor verification,
Safe batch simulation, guarded trial, receipt checks and rollback. Keep the existing vault and
its user positions; the reward relay and guarded executor connect through existing setters.

No deployment address is assigned to a helper by this branch. Editing Solidity does not update
an already deployed contract. Source verification and explicit Safe transactions are required.

## Build and test

```sh
npm ci
npm test
```

`build/` contains generated ABIs and bytecode. It is not committed. The legacy sources remain
unchanged so their deployment artifacts and existing tests remain comparable.

Frontend still uses the original vault and distributor addresses. Hosting remains GitHub Pages:
https://bigebelieves.github.io/staked-vault/
