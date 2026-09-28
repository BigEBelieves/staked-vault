# Keeper runbook

The vault and distributor are live on Base and fully wired. Nothing runs by itself — a keeper (the owner
wallet `0x1a3091097126d69a4f955051d4d018c1ae3cdcf8`, or any wallet set via `setKeeper`) pushes the loop below once a
day. All swap-type calls take a caller-supplied minimum output, so the keeper is the only party that can move value
through a DEX and it always does so behind a slippage bound.

| Contract | Address |
|---|---|
| StakedVault | `0x01b568eBCFb8c6db2Cf1c5f70c9b105f4187D92F` |
| StakedDistributor | `0xDdf0eC9aA4d36eD07257187b524a8810c5BCF376` |
| StakedBuybackExecutor | `0x290072cF64963D469a6be9d124D7328bf2992755` |
| STAKED | `0x731d4066a8375fc590fcd9dfe8d9e58670cb8ba3` |
| BNKR | `0x22af33fe49fd1fa80c7149773dde5890d3c76f3b` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

One-time setup (done Sep 28 2026): max approvals from the owner wallet
`STAKED -> Distributor`, `BNKR -> Distributor`, `BNKR -> Vault`.

## Daily loop

1. **Claim pool fees** — the $STAKED v4 pool pays the owner wallet in STAKED + BNKR (95% share). Claim through Bankr
   (`claim_token_fees` on the STAKED address). Skip if claimable is dust (< 1,000 STAKED and < 100 BNKR).
2. **Distribute** — `Distributor.depositAndDistribute(stakedWei, bnkrWei)` with exactly the claimed amounts.
   Effect: 50% STAKED -> 0xdead, 50% STAKED -> liquidity wallet, 50% BNKR -> Bankr-staking wallet, 50% BNKR -> `pendingSwapBnkr`.
3. **USDC leg** — if `Distributor.canSwap()` is true (`pendingSwapBnkr >= minBnkrBatch`, currently 240,000 BNKR ~ $100):
   quote BNKR -> WETH -> USDC, set `minUsdcOut = quote * 0.97` (6 decimals), call `swapAndNotify(minUsdcOut)`.
   The USDC lands in the vault and streams to stakers over the next 7 days.
4. **BNKR staking leg (path A)** — stake whatever BNKR the distributor sent to the owner wallet into the Bankr staking
   program (`stake`, never `restake_rewards`, so the 2x multiplier clock is not reset).
5. **Relay staking yield** — claim BNKR rewards from Bankr staking (`claim_rewards`), then
   `Vault.notifyRewardAmount(BNKR, amountWei)` from the owner wallet. Streams to $STAKED stakers over 7 days.
   (Bankr weekly rewards had not started as of Sep 28 2026, so this leg is 0 until they do.)
6. **Buyback and burn** — if `Vault.buybackReserve() >= 1 USDC`: quote USDC -> STAKED through the executor path
   (USDC -> WETH -> BNKR on v3, BNKR -> STAKED on the v4 pool), set `minStakedOut = quote * 0.95`, call
   `Vault.executeBuyback(reserve, minStakedOut)`. Delivered STAKED is burned to 0xdead inside the call.
7. **Restream** — if `Vault.totalSupply() > 0` and `rewardData(token).undistributed > 0` for USDC or BNKR, call
   `restreamUndistributed(token)` (permissionless) so rewards that streamed while nobody was staked are not stranded.
8. **Gas** — keep the keeper wallet above ~0.002 ETH on Base.

## Thresholds and knobs (owner only)

- `Distributor.setMinBnkrBatch(wei)` — USDC-leg batch size; retune as BNKR price moves.
- `Distributor.setPoolFees(bnkrWethFee, wethUsdcFee)` — v3 fee tiers on the swap path (1% / 0.05% today).
- `Vault.setRewardsDuration(seconds)` — stream length, only when both streams are finished.
- `Vault.setKeeper / Distributor.setKeeper` — hand the loop to a dedicated bot wallet later.

## First pass (Sep 28 2026)

- Claimed 15,344.06 STAKED + 0.00996 BNKR, `depositAndDistribute` executed:
  7,672.03 STAKED burned, 7,672.03 STAKED to liquidity wallet, 0.00498 BNKR to staking wallet, 0.00498 BNKR queued.
- Swap / stake / relay / buyback legs skipped: all below thresholds.
