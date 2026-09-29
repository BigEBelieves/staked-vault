# Guarded automation proposal — NOT DEPLOYED

This change adds four helpers around the existing non-upgradeable vault and distributor.
No user stakes, queued BNKR, reward accounting, or buyback reserves need to move to a new vault.
The legacy contract implementations are retained verbatim for compatibility and verification.

The [deployment package](DEPLOYMENT-PACKAGE.md) generates constructor calldata and verifies
actual deployments before producing paused wiring, fee-rights, or rollback Safe batches.
See [REVIEW-HANDOFF.md](REVIEW-HANDOFF.md) for independent review scope and
[PRIVATE-SUBMISSION.md](PRIVATE-SUBMISSION.md) for the Base provider findings and remaining checks.

## What this version does

| Component | Authority and behavior |
|---|---|
| `StakedFeeCollector` | Anyone can trigger collection. Actual beneficiary payouts go directly to the existing distributor. Only the Safe can recover fee rights or sweep to the Safe. |
| `StakedRewardRelay` | Existing distributor can forward USDC; Safe and explicitly authorized donors can relay their own BNKR. All rewards go to the existing vault. |
| `StakedAutomationGuard` | Safe sets references, expiry, cumulative budgets, caps and operator. Bankr can execute permitted calls or pause. Bankr cannot unpause or change policy. |
| `StakedBoundedBuybackExecutor` | Only the original vault, during an active guard call, can buy back. Fixed route, nonzero v3 minimum, Safe-set v4 price limit, exact input consumption and measured final delivery. |

All helper authority is bound to the Safe address at construction. Change signers inside the Safe;
changing the authority address requires deploying replacements. There are no arbitrary-call entry points.

## Price protection and its limits

**This is a governed, expiring limit-order design, not a TWAP implementation.**
Uniswap v4 does not provide a built-in oracle. We have not validated an independent STAKED feed
or an oracle implemented by this pool's hook. Deriving a floor from its current spot price would
not make that floor independent of pool manipulation.

The Safe independently reviews and approves three reference quotes:

1. BNKR input -> USDC output for distribution.
2. USDC input -> BNKR output for the first buyback leg.
3. USDC input -> final STAKED output for the complete buyback.

Each reference is a ratio in raw token units, with a **maximum 100 bps (1%) discount**.
For each trade, the guard scales the reference to its input amount and rounds minima up.
Quotes should be evaluated at the maximum intended batch size; a small-trade quote is not
necessarily attainable for a large trade. USDC has 6 decimals; BNKR and STAKED have 18.
No sample prices or budgets in this repository are suitable for production approval.

Policies expire within one hour and have per-trade caps AND cumulative input budgets.
Replacing a policy resets its budgets and invalidates outstanding transaction nonces.
A compromised Bankr key can spend the remaining approved budget at the approved prices;
it can still choose unfavorable timing inside that window. Safe references can become stale
before expiry. Choose shorter validity and smaller budgets when appropriate.

The v4 `sqrtPriceLimitX96` is an absolute Safe-approved boundary. It must be independently
calculated from the reviewed pool price, direction and acceptable price movement. The contract
rejects the previous extreme limits but does not certify that a Safe-supplied limit is economically
sensible. BNKR is currency0 on Base, so this route uses a lower sqrt-price boundary. For the
opposite sorting it would need an upper boundary. A partial fill reverts the entire transaction.
Hook fees and custom accounting can affect execution; test the actual deployed hook.

The quote planner uses 50 bps by default, refuses over 100, and takes the stricter of its fresh
quote floor and the Safe's floor. Every read, quote and simulation is pinned to one block. It
rejects a changed head before returning calldata. The guard permits at most two blocks of delay,
a short deadline and an exact nonce. **The keeper-supplied block number is not a price attestation.**
The Safe reference remains the independent constraint if the keeper lies about quotes.
A quote at one block does not guarantee inclusion in that block.

A validated oracle, manipulation analysis and feed-failure policy are still required before
replacing manual Safe policy renewal with unattended reference updates. Never give Bankr
permission to update the reference as a shortcut.

## Current deployment and migration order

`config/base.json` records the known Base addresses. Re-read all state before execution; the
configuration is not a claim of current on-chain state. The Safe currently holds the 95% fee
share following the beneficiary transfer. New helpers have **not** been deployed or wired.

### 1. Review and test

- Run `npm ci` and `npm test`. Review the diff and verified legacy source.
- Fork Base at a recorded block. Exercise the real SwapRouter02, PoolManager, Doppler hook,
  fee collection and Safe batch. Mocks do not validate hook behavior, liquidity or private RPCs.
- On that fork, verify `owner()` for the vault/distributor/legacy executor is the Safe, all
  `pendingOwner()` values are zero, and both old keeper fields are zero.
- Verify the Safe's owners/threshold, `getShares(poolId, Safe) == 950000000000000000`,
  Bankr's share is zero, and both distributor payout wallets are the Safe.
- Verify all token/router/pool/fee-tier addresses, live code and source verification independently.
- Model adverse price movement, hook fee changes, manipulated spot quotes, failed collection,
  partial v4 fills and policy expiry. Select initial caps from actual liquidity, not historical prices.

### 2. Deploy helpers, initially disabled

Use the Safe as `safe_` in every constructor, regardless of who pays deployment gas.
Use addresses from `config/base.json` for the existing components.

| Deploy order | Constructor |
|---|---|
| 1. Reward relay | `(safe, vault, distributor, usdc, bnkr)` |
| 2. Automation guard | `(safe, vault, distributor)` |
| 3. Bounded executor | `(safe, Config)` as below |
| 4. Fee collector | `(safe, initializer, poolId, staked, bnkr, distributor)` |

Executor `Config`: existing vault, NEW guard, USDC, WETH, BNKR, STAKED, v3 router, PoolManager,
`feeUsdcWeth=500`, `feeWethBnkr=10000`, `v4Fee=8388608`, `tickSpacing=200`, `hooks=initializer`.
Verify constructor ordering from the generated ABI. Publish source with solc 0.8.24,
optimizer 200, EVM Paris. Record the four new addresses and deployment transaction hashes.

Guard starts paused, without an operator, executor, references or budgets. Relay starts without
any external yield sources. Deployment alone does not enable automation.

### 3. Simulate one atomic Safe wiring batch

Every call below is from the Safe, with zero ETH. Substitute the verified NEW addresses.

1. `vault.setKeeper(address(0))` and `distributor.setKeeper(address(0))`.
2. `guard.setExecutor(newExecutor)` while the guard is paused.
3. `distributor.setVault(newRelay)`.
4. `vault.setDistributor(newRelay)`.
5. `vault.setBuybackExecutor(newExecutor)`.
6. `vault.setKeeper(newGuard)` and `distributor.setKeeper(newGuard)`.
7. Verify/set `distributor.setLiquidityWallet(Safe)` and `setBnkrStakingWallet(Safe)`.

Steps 3–4 must be in the same batch: the old distributor still runs its original accounting;
its USDC notification now passes through the relay to the original vault. Pending BNKR stays
in place. The `vault()` getter on the distributor will intentionally return the relay address.
All owners stay the Safe. **Never put Bankr directly back into either legacy keeper field.**

Do not include an unpause call in this first batch. Validate readbacks and simulate each end-to-end
path on the fork before the production batch. After execution, compare wiring, owners and balances.

### 4. Move fee rights only after collector verification

This is a separate Safe decision: automated collection requires the helper itself to be the beneficiary.
Calling `collectFees` from Bankr does not withdraw the Safe's share.

From the Safe, call the Doppler initializer `collectFees(poolId)` to settle current fees to the Safe,
then `updateBeneficiary(poolId, newCollector)`. Those settled tokens stay in the Safe; they are
not automatically swept. Use a separate exact-amount approval/deposit batch if distributing them.

Verify `getShares(poolId, newCollector) == 950000000000000000`, Safe and Bankr shares zero, and
other beneficiary share still `50000000000000000`. The fee collector does not need a fee-claim
allowance from Bankr or the Safe. Call `collector.collectAndDistribute()` to test the payout path.
Check actual token transfers, exact allowances returning to zero, burn, Safe payouts and pending BNKR.

### 5. Enable only a small bounded trial

From the Safe, set `guard.setOperator(Bankr)`, review a fresh `Policy`, then `setPolicy(policy)`
and `setPaused(false)`. Policy values must be reviewed using an independent market reference;
do not rubber-stamp Bankr's proposed prices. Execute one small swap and verify the receipt.

To relay rewards, the Safe can approve an exact BNKR amount to the relay and call `relayBnkr(amount)`.
Authorizing another donor via `setYieldSource(source, true)` is optional. An authorized donor can
restart a reward stream by funding it; avoid authorizing untrusted donors. The relay pulls only
from the caller, so a donor cannot spend a Safe allowance.

The old BNKR staking position remains owned by Bankr. This change cannot move it, make Bankr
claim it, or protect it from a compromised Bankr key. Unstaking/restaking is a separate decision
with cooldown/multiplier consequences. No contract here interacts with the staking program.

### 6. Quote, simulate, submit privately, verify

See `KEEPER.md`. Do not recreate the old scheduled Bankr command. Verify that the chosen provider
supports private submission on **Base** and how it handles failures. A private URL name does not
prove privacy. If private submission is unsupported, stop the swap job; do not silently broadcast
through another endpoint. The repository prepares unsigned calldata and does not sign or send it.

## Emergency actions / rollback

- Safe or current operator: `guard.setPaused(true)`. Only Safe can unpause.
- Safe: disable operator (`setOperator(address(0))`) and/or set both legacy keepers to zero.
- Safe: `collector.returnBeneficiaryToSafe()` restores its fee share and transfers its STAKED/BNKR
  balance to the Safe. It does not rely on the distributor working. Verify shares afterward.
- To remove the reward relay: in one Safe batch with keepers disabled, set `distributor.setVault(originalVault)`
  and `vault.setDistributor(originalDistributor)`. This does not remove already streamed rewards.
- Replacing the new executor with the legacy executor restores the legacy swap weaknesses. Keep
  swaps disabled rather than treating that as a safe automation rollback.

## Verification scope

The local suite uses the real legacy vault/distributor bytecode and new helper bytecode with
mock ERC20s, router, Doppler fee manager and PoolManager. It checks role separation, payout routing,
zero residual allowances, floors, replay, budgets, expiry, callback authorization, partial-fill
rollback and original reward accounting. The planner tests pinned reads and failure to prepare
unsafe/stale calls. In addition, **67 checks passed on a Base fork at block 51,929,714**,
including the actual Safe batch, Doppler fees, v3/v4 swaps, a rejected v4 fill and rollback.
See [FORK-TESTING.md](FORK-TESTING.md) for reproduction commands and the exact fixture changes.
No production contract code change was needed after the fork run. This is not an independent audit.
Retest against fresh state and review actual deployment transactions before activation.

Primary references:
- [Uniswap v4 whitepaper, oracle architecture](https://app.uniswap.org/whitepaper-v4.pdf)
- [Uniswap PoolManager interface](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol)
- [Uniswap IV4Quoter interface](https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol)
- [Doppler source](https://github.com/whetstoneresearch/doppler)
- [Deployed initializer source](https://basescan.org/address/0xbdf938149ac6a781f94faa0ed45e6a0e984c6544#code)
- [Base transaction ordering](https://docs.base.org/base-chain/network-information/transaction-ordering)

Use verified deployed source for the initializer: latest upstream has differences from the
currently deployed `updateBeneficiary` implementation. `collectFees` return values represent
new pool fees; token balance changes establish the actual beneficiary payout.
