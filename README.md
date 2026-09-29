# $STAKED Vault

Dual-reward staking for **$STAKED** on Base, funded by the STAKED/BNKR Uniswap v4 pool fees.

- Token: `0x731d4066a8375fc590fcd9dfe8d9e58670cb8ba3` ($STAKED, Base)
- Pair: STAKED / BNKR (Uniswap v4)
- Rewards: **USDC** + **BNKR**, streamed continuously (7-day rolling periods)

## Security migration status

The Safe `0xb9066550918fa778a4039120eac878230cf8f6FC` is the administrative owner following the ownership migration.
Legacy automation is disabled. This branch proposes helper contracts for fixed-destination fee collection,
reward forwarding and Safe-bounded trading. **The new helpers are not deployed.**
Read [SECURITY-MIGRATION.md](SECURITY-MIGRATION.md) before enabling any keeper.

## Layout

```
contracts/StakedVault.sol            7-day lock, dual-reward vault, 20% early-exit burn, buyback reserve
contracts/StakedDistributor.sol      fee splitter + batched BNKR -> WETH -> USDC swap -> vault
contracts/StakedBuybackExecutor.sol  USDC -> WETH -> BNKR (v3) -> STAKED (v4 PoolManager) buyback route
contracts/test/Mocks.sol             mock ERC20 / router / buyback executor used by the tests
contracts/StakedFeeCollector.sol     permissionless fee collection to fixed distributor
contracts/StakedRewardRelay.sol      USDC/BNKR adapter for the existing vault
contracts/StakedAutomationGuard.sol  Safe references, expiry, trade caps and total budgets
contracts/StakedBoundedBuybackExecutor.sol guarded replacement buyback route
test/vault.test.mjs                  original 66 checks on an in-process EVM (ethereumjs)
test/automation.test.mjs             helper integration and adversarial checks
scripts/prepare-keeper.mjs           pinned quotes and simulation; unsigned calldata only
scripts/compile.mjs                  solc 0.8.24, optimizer 200, evm paris -> build/
web/index.html                       standalone dapp (also copied to /index.html for GitHub Pages)
DEPLOY.md                            deploy + wiring checklist
```

## Economics

**$STAKED pool fees**
- 50% burned to `0x000000000000000000000000000000000000dEaD`
- 50% to the configured liquidity wallet (Safe after migration)

**BNKR pool fees**
- 50% to the configured BNKR staking wallet (Safe after migration); staking and yield deposits require separate action
- 50% batched in the distributor until the configured minimum batch, then swapped BNKR -> WETH -> USDC on Uniswap v3 and streamed to stakers

**Staking**
- 7-day lock. Any top-up resets the 7-day timer for the wallet's whole balance.
- Rewards (USDC + BNKR) accrue continuously; claimable once unlocked.
- Early exit: 20% of the withdrawn principal burned, 80% returned, all accrued rewards forfeited.
  - forfeited USDC -> buyback reserve -> keeper buys $STAKED (USDC -> WETH -> BNKR -> STAKED) and burns it
  - forfeited BNKR -> re-streamed to remaining stakers

## Security properties

- 1e36 reward precision (safe for 6-decimal USDC against a 100B-supply 18-decimal staking token)
- Reentrancy guards on asset-moving entry points
- `Ownable2Step` on the original contracts; new helpers bind authority to the Safe
- Legacy keeper-supplied minima alone do not protect against a compromised keeper; the proposed guard adds Safe-approved expiring floors and budgets
- The replacement executor bounds the intermediate v3 output and v4 price, and rejects partial fills
- No validated STAKED TWAP is included; the Safe must renew reference policies manually
- `recoverERC20` can never touch STAKED, USDC or BNKR
- Rewards streamed while nobody is staked are tracked and can be re-streamed permissionlessly

## Build & test

```
npm ci
npm test      # compiles, then runs original, helper and quote-planner tests
```

## Web app

`web/index.html` is a single static file (ethers v5 via CDN). GitHub Pages serves it from `/index.html` on `main` / root.

Live: https://bigebelieves.github.io/staked-vault/

## Status

**Original contracts deployed on Base mainnet (Sep 28, 2026).** Safe migration supersedes the original Bankr ownership. Re-read live state before use; proposed helpers remain undeployed.

| Contract | Address |
| --- | --- |
| StakedVault | [0x01b568eBCFb8c6db2Cf1c5f70c9b105f4187D92F](https://basescan.org/address/0x01b568eBCFb8c6db2Cf1c5f70c9b105f4187D92F) |
| StakedDistributor | [0xDdf0eC9aA4d36eD07257187b524a8810c5BCF376](https://basescan.org/address/0xDdf0eC9aA4d36eD07257187b524a8810c5BCF376) |
| StakedBuybackExecutor | [0x290072cF64963D469a6be9d124D7328bf2992755](https://basescan.org/address/0x290072cF64963D469a6be9d124D7328bf2992755) |

Compiler: solc 0.8.24, optimizer 200 runs, evm paris.

Deployment and verification: [SECURITY-MIGRATION.md](SECURITY-MIGRATION.md). Updated keeper procedure: [KEEPER.md](KEEPER.md).
