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

The recorded integration run passed 67 checks against Base block 51,929,714, including actual
Safe execution, fee collection, v3/v4 swaps and rollback. See [FORK-TESTING.md](FORK-TESTING.md).
The helpers are now deployed. Fresh-state Safe batch simulation and independent review remain required before activation.

## Helpers connected — trading paused

The ten-call wiring batch executed successfully at Base block **51944324**:
[0xcb4976cbaec92290de5ff14564d75fa43b91a92773a6113babad70dbda534e71](https://basescan.org/tx/0xcb4976cbaec92290de5ff14564d75fa43b91a92773a6113babad70dbda534e71). Safe nonce 4 was consumed; the nonce is now 5.

Configuration verified at Base block **51944466**. The vault and distributor both use
the guard as keeper and the relay for rewards. The vault and guard point to the bounded executor.
The guard remains paused with no operator or spending budget. Ownership and payouts remain with
the 2-of-3 Safe; all four helper runtimes match the deployed build. The Safe still owns the 95%
fee share, the collector owns 0%, and all three Bankr allowances remain zero. Fee-rights transfer
and trading activation are separate pending stages.

The wallet submitted through an ERC-4337 EntryPoint. Safe selected official MultiSendCallOnly
v1.5.0 at `0xA83c336B20401Af773B6219BA5027174338D1836`, rather than the v1.4.1
library used in the local rehearsal. All ten inner calls matched exactly. The emitted Safe
transaction hash was recomputed at nonce 4, and the v1.5.0 runtime matched the official Safe
deployment registry. See [the live wiring record](deployments/base-20260929-wiring.json).

Deployment source: `94e771c9e528028792b2100968778fdcaa870b33`. Rabby EOA: `0xa741dad09fff5de643283142ed339b9f0b52b146`, nonces 199–202.
All four direct creations succeeded with zero ETH constructor value.

| Helper | Address / verified source | Deployment transaction |
|---|---|---|
| StakedRewardRelay | [0x0489c70E4C51F1518f3514728CDfB77F6a4A2C88](https://repo.sourcify.dev/8453/0x0489c70E4C51F1518f3514728CDfB77F6a4A2C88) | [0x2e92ebbc…](https://basescan.org/tx/0x2e92ebbcf0ed7c391e85d40ee7c013bc388d4477c4527a7f9aeef6f3924a99a3) |
| StakedAutomationGuard | [0x2962643Fe17228D05bB51f71378e6d258b96848e](https://repo.sourcify.dev/8453/0x2962643Fe17228D05bB51f71378e6d258b96848e) | [0x1d38eb66…](https://basescan.org/tx/0x1d38eb669a7b417bf44d436eb24b5436ddac9b2a083de71cc14ab3c6c0f4263b) |
| StakedBoundedBuybackExecutor | [0xEfDdAECA280FdAD3ce8aF2A42177E1fF5925a8B5](https://repo.sourcify.dev/8453/0xEfDdAECA280FdAD3ce8aF2A42177E1fF5925a8B5) | [0x77316780…](https://basescan.org/tx/0x77316780622c9c17c7528115b6995532efa7e62ddf0f768390af14cdc8d4945e) |
| StakedFeeCollector | [0xb6F61e30420bad8F5C636E8DDFFba61a90167393](https://repo.sourcify.dev/8453/0xb6F61e30420bad8F5C636E8DDFFba61a90167393) | [0x48a6b1b6…](https://basescan.org/tx/0x48a6b1b6195a561685b1cebab91f7d08f657bcf51755c9e802ad0ff2ddbaf1e0) |

Sourcify reports exact creation and runtime source matches for all four contracts. Its automatic
submissions to Etherscan/BaseScan and Blockscout hit provider limits, so this does not claim
verification on those explorers. Source matching is not an independent security audit.

See [initial deployment verification](deployments/base-20260929-verification.json) and
[source-verification responses](deployments/base-20260929-sources.json).

Use [DEPLOYMENT-PACKAGE.md](DEPLOYMENT-PACKAGE.md) for the unsigned deployment planner,
receipt/runtime verification, and staged Safe batch generator. The independent review scope is in
[REVIEW-HANDOFF.md](REVIEW-HANDOFF.md); Base provider findings are in
[PRIVATE-SUBMISSION.md](PRIVATE-SUBMISSION.md).

Follow [SECURITY-MIGRATION.md](SECURITY-MIGRATION.md), including fork tests, constructor verification,
Safe batch simulation, guarded trial, receipt checks and rollback. Keep the existing vault and
its user positions; the reward relay and guarded executor connect through existing setters.

Editing Solidity does not update an already deployed contract. Wiring is complete; do not repeat
the deployment or wiring transactions. Trading activation remains a separate Safe decision.

## Build and test

```sh
npm ci
npm test
```

`build/` contains generated ABIs and bytecode. It is not committed. The legacy sources remain
unchanged so their deployment artifacts and existing tests remain comparable.

Frontend still uses the original vault and distributor addresses. Hosting remains GitHub Pages:
https://bigebelieves.github.io/staked-vault/
