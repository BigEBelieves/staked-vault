# Deploy checklist (Base mainnet)

## Deployed (Sep 28, 2026)

| Contract | Address |
|---|---|
| StakedVault | `0x01b568eBCFb8c6db2Cf1c5f70c9b105f4187D92F` |
| StakedDistributor | `0xDdf0eC9aA4d36eD07257187b524a8810c5BCF376` |
| StakedBuybackExecutor | `0x290072cF64963D469a6be9d124D7328bf2992755` |

Wiring completed on the vault: `setDistributor`, `setKeeper`, `setBuybackExecutor`.
Owner / keeper: `0x1a3091097126d69a4f955051d4d018c1ae3cdcf8`.

Frontend `CONFIG` in `index.html` and `web/index.html` points at the vault and distributor above.

Still pending: Basescan source verification (see section 5) and the keeper automation (section 3).

---

Addresses on Base:
- STAKED  `0x731d4066a8375fc590fcd9dfe8d9e58670cb8ba3`
- BNKR    `0x22af33fe49fd1fa80c7149773dde5890d3c76f3b`
- USDC    `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- WETH    `0x4200000000000000000000000000000000000006`
- Uniswap SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`

## 1. StakedVault

constructor: `(staked, usdc, bnkr, owner)`

After deploy:
- `setKeeper(<keeper>)` — the automation wallet allowed to call `executeBuyback`
- `setBuybackExecutor(<executor>)` — contract implementing `IBuybackExecutor.buyback(usdcAmount, minStakedOut)` that routes USDC -> WETH -> BNKR (v3) -> STAKED (v4) and returns STAKED to the vault

## 2. StakedDistributor

constructor: `(staked, bnkr, usdc, weth, swapRouter02, vault, owner, minBnkrBatch)`

`minBnkrBatch` is denominated in BNKR wei; set it to roughly $100 of BNKR at deploy time and adjust with `setMinBnkrBatch` as price moves.

After deploy:
- `vault.setDistributor(<distributor>)`
- `distributor.setKeeper(<keeper>)`

## 3. Fee intake

The $STAKED pool fee recipient stays on the owner wallet. The keeper automation:
1. claims accrued STAKED + BNKR fees to the owner wallet
2. approves and calls `distributor.depositAndDistribute(stakedAmt, bnkrAmt)`
3. when `pendingSwapBnkr >= minBnkrBatch`, quotes the route and calls `distributor.swapAndNotify(minUsdcOut)`
4. stakes the owner's BNKR share, claims BNKR staking yield, and calls `vault.notifyRewardAmount(bnkr, amount)`
5. when `vault.buybackReserve() > 0`, quotes and calls `vault.executeBuyback(usdcAmount, minStakedOut)`

## 4. Frontend

Paste the vault and distributor addresses into `CONFIG` in `web/index.html` and `index.html`, commit, and enable GitHub Pages (main / root).

## 5. Verify

Verify all three contracts on Basescan with solc 0.8.24, optimizer on (200 runs), evm version paris.
