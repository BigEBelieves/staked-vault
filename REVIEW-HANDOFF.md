# Independent review handoff

Status: author review and automated tests completed; **no independent reviewer has signed off**.
Review the exact PR head and record that full commit hash in the review. Later changes invalidate
approval for the affected scope. Deployment is a separate action requiring source/receipt checks.

## Scope

- `AutomationSupport.sol`, `StakedFeeCollector.sol`, `StakedRewardRelay.sol`,
  `StakedAutomationGuard.sol`, `StakedBoundedBuybackExecutor.sol`.
- Their interactions with the unchanged `StakedVault.sol`, `StakedDistributor.sol`, existing
  Safe, token contracts, v3 router, v4 PoolManager and deployed Doppler initializer/hook.
- `scripts/keeper-plan.mjs`, `scripts/prepare-keeper.mjs`, `scripts/deployment-plan.mjs`,
  `scripts/prepare-deployment.mjs`, compilation settings and Base configuration.
- Migration, fee-rights transfer, production policies, signing route and emergency recovery.

## Questions the reviewer must resolve

1. Can a compromised operator change recipients, executor, approvals, prices, limits or authority?
   Does a legacy keeper path, owner exception or active callback permit a guard bypass?
2. Can a fee claimant redirect Safe/collector shares, strand claimed tokens, exploit reentry, or
   break recovery? Check deployed initializer behavior rather than assuming latest upstream.
3. Are original principal/reward accounting and queued BNKR preserved by both relay links?
   Assess rounding, donations, stream restarts and failure of either linked contract.
4. Are reference scaling, token decimals, intermediate minima, cumulative budgets, deadlines,
   block-age and nonce handling correct across every successful and reverting path?
5. Does callback context plus exact settlement reject repeated/spoofed callbacks, partial fills,
   hook accounting surprises, transfer shortfalls and residual approvals?
6. Independently assess market depth and manipulation. The present policy is a manually approved
   limit order with at most one-hour validity, not an oracle. Determine reasonable caps, expiry and
   the absolute sqrt-price boundary. Do not use fork fixture prices as production recommendations.
7. Verify EIP-7702/ZeroDev signing and provider disclosure/fallback behavior. A URL named
   `PRIVATE_BASE_RPC_URL` is not evidence of privacy.
8. Verify direct-CREATE nonces, exact constructor calldata, runtime immutables, published source,
   and Safe batch targets/calldata. Check stale snapshots and Safe nonce changes before execution.

## Author review observations

- Constructor Safe authority is fixed, the keeper cannot renew policies or unpause, and helper
  payouts have fixed destinations. Safe signer rotation therefore occurs within the existing Safe.
- Exact approvals are reset; callback, partial-fill and final-delivery failures revert whole swaps.
- Policy replacement resets cumulative budgets. Repeated Safe approvals can authorize more
  spending; a review must assess that operational exposure as well as each individual policy.
- Both reward authorization links must change atomically. Fee rights move in a separate transaction
  only after helper verification. The wiring generator enforces the corresponding initial state.
- Live legacy sources remain unchanged. The Safe and third-party token/router/hook behavior remain
  part of the trust model. Runtime checks on new helpers do not audit those dependencies.
- The old Bankr BNKR staking position is outside this migration. No unstaking, transfer or restaking
  is included. Existing Safe-held fees are not automatically invested.

## Evidence and acceptance record

Run `npm test` and `npm run test:fork`; see [FORK-TESTING.md](FORK-TESTING.md) for fixture changes
and pinned state. Generated deployment calldata and all three migration stages are exercised
through the actual Safe on the local fork. Negative cases reject mismatched manifests/receipts,
changed code, premature fee transfer and repeated wiring. No live wallet signature is tested.

The independent report should name the reviewed commit, reviewer, date, findings/severity,
resolution commits, remaining assumptions, and explicit deployment recommendation. No reviewer
is assigned by this document. Do not mark this gate complete merely because the author reruns tests.
