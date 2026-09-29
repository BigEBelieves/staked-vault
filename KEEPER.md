# Keeper runbook — helpers deployed, activation pending

**Keep the old jobs disabled.** The previous daily/hourly Bankr commands are retired. They relied
on Bankr owning contracts, holding fee rights and using 3–5% quote tolerances. The Safe now owns
those administrative rights; the four helper contracts are deployed but still require Safe wiring and review before activation.
See [DEPLOY.md](DEPLOY.md) for the deployment record.
See [SECURITY-MIGRATION.md](SECURITY-MIGRATION.md) for the complete wiring and test gates.
See [PRIVATE-SUBMISSION.md](PRIVATE-SUBMISSION.md) for documented Base submission options and
the still-unverified provider/Bankr signing requirements. No sender is implemented in this branch.

## Intended authority after wiring

- Safe: protocol owners, payout destination, helper authority, policy approvals and unpause.
- Guard: the only automation keeper address configured on the existing vault and distributor.
- Bankr: guard operator only; optionally a BNKR donor if the Safe separately authorizes it.
- Collector: pool beneficiary after an explicit Safe transfer; anyone may trigger collection.
- No unlimited approvals from Bankr or the Safe are needed for collecting or swapping pool fees.

## Safe-approved trading windows

Each policy expires within one hour, sets at most 1% slippage from three independently reviewed
reference quotes, caps each trade, caps total spending, and specifies an absolute v4 price boundary.
Expiry or exhausted budgets stop execution. Only the Safe can renew. This version does not provide
unattended oracle updates, and the policy is not a TWAP.

## Loop after wiring and activation

1. Trigger `collector.collectAndDistribute()`. No swap occurs. Fee splits go to burn, Safe and queue.
2. Read `pendingSwapBnkr`, policy, remaining budget, pause state and nonce. If the full queue exceeds
   its cap, skip and request Safe review. The existing distributor cannot partially drain the queue.
3. For distribution, quote BNKR -> WETH -> USDC and simulate the guard call at a single latest block.
4. For buyback, choose a reserve amount within both caps. Quote USDC -> WETH -> BNKR and then the
   v4 BNKR -> STAKED leg at that same block. Simulate the complete guard/vault/executor call, including
   the real hook and the Safe price limit. Inability to fill the complete input causes a revert.
5. Use the greater of the Safe floor and a fresh quote discounted by at most 1% (default 0.5%).
   Check head again immediately before signing. Every successful call consumes a nonce; prepare
   distribution and buyback separately. A changed head or batch requires a new quote.
6. Sign using the limited operator and submit through a provider verified to support Base private
   transactions. Use that provider's required submission method. Never fall back to public submission.
   Check head/deadline again after wallet signing; abandon expired calldata and requote.
7. Verify receipt status and token flows: USDC rewards into original vault, buyback STAKED to burn,
   exact reserve decrement, expected budgets, and zero allowances. Reverted calls consume no budget.
8. Staking Safe-held BNKR and handling the old Bankr-owned staking position are separate operations.
   The relay only deposits BNKR already owned by its caller. It does not claim external staking yield.

## Unsigned quote planner

Build first with `npm run compile`. Configure these environment variables locally:

- `PRIVATE_BASE_RPC_URL`: provider endpoint, independently checked for Base support and privacy.
- `GUARD_ADDRESS`: verified new guard.
- `V3_QUOTER_ADDRESS`: verified Base Uniswap QuoterV2.
- `V4_QUOTER_ADDRESS`: verified Base Uniswap V4Quoter (required for buyback).
- `SLIPPAGE_BPS`: optional, default 50, maximum 100.

```sh
node scripts/prepare-keeper.mjs distribute
node scripts/prepare-keeper.mjs buyback 1000000
```

The second command prepares a 1-USDC buyback (6 decimals). It does not recommend that trade size.
Both commands only print unsigned calldata and quote metadata; no private keys are read and no
transaction is sent. Sign/submit immediately through the operator integration after rechecking
head, deadline and nonce. A saved plan is not a reusable schedule or perpetual authorization.

A fresh quote is not a guaranteed execution price or same-block inclusion. The contract accepts
at most two blocks of delay, and its independent Safe floor still applies if the keeper lies about
the quote. Private submission reduces exposure but does not replace price bounds or ensure execution.

## Pause

Operator may call `guard.setPaused(true)`; only Safe may unpause. Safe may also zero the operator
and both legacy keeper fields. Do not restore Bankr directly as a legacy keeper.
