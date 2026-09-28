# Deploy checklist (Base mainnet)

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

Verify both contracts on Basescan with solc 0.8.24, optimizer on (200 runs), evm version paris.
