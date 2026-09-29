# Preparing the first trading window

This tooling only reads state, quotes and simulates. It does not sign, submit, fund contracts,
restart jobs or unpause trading. The existing helper contracts are unchanged.

## Check funding

Compile with `npm run compile`, configure `BASE_READ_RPC_URL` locally, then run:

```sh
node scripts/prepare-trial-policy.mjs
```

The report distinguishes the distributor's accounted BNKR queue from the vault's accounted USDC
buyback reserve. It reports the existing minimum batch, operator, pause state and remaining budgets.
It never counts wallet holdings toward these balances. Collection can be simulated separately to
check whether new fees would increase the queue. An empty collection is not a positive payout test.

A below-minimum queue must wait for eligible fees or a separately approved funding/threshold
decision. A direct USDC token transfer does not increase `buybackReserve`. Do not manufacture
reserve by withdrawing another user's stake or altering accounting.

## Supply reviewed limits

The planner takes a local JSON file with `validForSeconds` (default 1800, maximum 3600) and a `policy`
object. The policy fields follow the contract ABI:

| Field | Input and first-window constraint |
|---|---|
| `distribution` | `{amountIn, amountOut}` in raw BNKR / raw USDC; input equals `maxBnkrPerSwap`. |
| `buybackV3` | `{amountIn, amountOut}` in raw USDC / raw BNKR; input equals `maxUsdcPerBuyback`. |
| `buybackTotal` | `{amountIn, amountOut}` in raw USDC / raw STAKED; input equals `maxUsdcPerBuyback`. |
| `maxBnkrPerSwap` | Positive uint128 raw BNKR cap. |
| `maxUsdcPerBuyback` | Positive uint128 raw USDC cap. |
| `bnkrBudget` | Zero disables distribution; otherwise equals its cap and the complete current eligible queue. |
| `usdcBudget` | Zero disables buybacks; otherwise equals its cap and is no greater than the accounted reserve. |
| `sqrtPriceLimitX96` | Explicit reviewed absolute v4 limit, decimal integer string. For an enabled buyback it must be on the correct side and within 1% of the snapshot pool price. |
| `slippageBps` | Integer 0–100; defaults to 50 (0.5%). |

All token amounts are decimal **strings in raw units** (BNKR/STAKED 18 decimals, USDC 6).
The deployed contract requires positive references and caps for both modes even if one budget is
zero. A zero budget prevents that mode from spending. At least one budget must be nonzero here.
Each cumulative budget is limited to one trade cap. The guard can split that budget across smaller
trades; it does not enforce a one-call limit. The distributor always swaps its complete queue.

```sh
node scripts/prepare-trial-policy.mjs /path/to/reviewed-policy.json
```

The planner validates code/wiring, a 2-of-3 Safe, the configured operator, paused trading and zero
existing budgets. It checks funding before quoting. Enabled routes must meet the reviewed floors,
and those floors must be no more than 1% below the fresh route quotes. Reads and quotes share one
block; a changed head aborts preparation.

The JSON result includes review evidence and a `batch` member for Safe Transaction Builder.
**Only `setPolicy` is included.** No token approvals, transfers, ownership changes, keeper changes
or unpause are added. Expiry is computed from the preparation block; do not reuse an old export.

## Before activation

The exact Safe-sender `setPolicy` call is simulated. This is not a signed Safe execution or a full
swap rehearsal. In particular, the v4 quoter does not prove the chosen price limit can fill the
complete input. Rehearse the exact selected policy and both enabled swap routes on a current
local fork, then refresh the references before Safe signatures.

The on-chain reference floor is manually approved by the Safe. Fresh spot comparisons are not an
independent oracle or a TWAP. Price limits, quote minima and cumulative budgets remain necessary
even with private routing.

Keep trading paused until the actual Bankr sign-only format and private provider route are
verified. See [PRIVATE-SUBMISSION.md](PRIVATE-SUBMISSION.md). Policy approval is followed by a
separate Safe unpause decision; expiration can require a freshly reviewed replacement policy.
The keeper's post-sign `revalidateKeeper` check still needs a sender that authenticates the signed
bytes and has no public fallback. This repository has no sender or scheduled job.
