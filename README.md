# $STAKED Vault

Dual-reward staking for **$STAKED** on Base, funded by the STAKED/BNKR Uniswap v4 pool fees.

- Token: `0x731d4066a8375fc590fcd9dfe8d9e58670cb8ba3` ($STAKED, Base)
- Pair: STAKED / BNKR (Uniswap v4)
- Rewards: **USDC** + **BNKR**, streamed continuously (7-day rolling periods)

## Layout

```
contracts/StakedVault.sol         7-day lock, dual-reward vault, 20% early-exit burn, buyback reserve
contracts/StakedDistributor.sol   fee splitter + batched BNKR -> WETH -> USDC swap -> vault
contracts/test/Mocks.sol          mock ERC20 / router / buyback executor used by the tests
test/vault.test.mjs               66-case suite run on an in-process EVM (ethereumjs)
scripts/compile.mjs               solc 0.8.24, optimizer 200, evm paris -> build/
web/index.html                    standalone dapp (also copied to /index.html for GitHub Pages)
DEPLOY.md                         deploy + wiring checklist
```

## Economics

**$STAKED pool fees**
- 50% burned to `0x000000000000000000000000000000000000dEaD`
- 50% to the owner wallet for liquidity deepening

**BNKR pool fees**
- 50% to the owner wallet -> staked in BNKR staking; the yield is relayed into the vault as the BNKR reward stream
- 50% batched in the distributor until the minimum batch (~$100 BNKR), then swapped BNKR -> WETH -> USDC on Uniswap v3 and streamed to stakers

**Staking**
- 7-day lock. Any top-up resets the 7-day timer for the wallet's whole balance.
- Rewards (USDC + BNKR) accrue continuously; claimable once unlocked.
- Early exit: 20% of the withdrawn principal burned, 80% returned, all accrued rewards forfeited.
  - forfeited USDC -> buyback reserve -> keeper buys $STAKED (USDC -> WETH -> BNKR -> STAKED) and burns it
  - forfeited BNKR -> re-streamed to remaining stakers

## Security properties

- 1e36 reward precision (safe for 6-decimal USDC against a 100B-supply 18-decimal staking token)
- `nonReentrant` on every state-changing entry point
- `Ownable2Step` ownership on both contracts
- Swaps and buybacks are keeper-gated and require a caller-supplied `minOut` (no zero-slippage swaps)
- `recoverERC20` can never touch STAKED, USDC or BNKR
- Rewards streamed while nobody is staked are tracked and can be re-streamed permissionlessly

## Build & test

```
npm install
npm test      # compiles, then runs the 66-case suite
```

## Web app

`web/index.html` is a single static file (ethers v5 via CDN). Enable GitHub Pages on `main` / root and it serves from `/index.html`.
Set `VAULT_ADDRESS` and `DISTRIBUTOR_ADDRESS` in the `CONFIG` block after deployment.

## Status

Contracts compiled and tested. **Not yet deployed.** See `DEPLOY.md`.
