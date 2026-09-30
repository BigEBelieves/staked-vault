# BNKR staking yield integration — review candidate

Status: built for review; not deployed, not activated, no live transactions sent.

## What this adds

The existing V3 distributor sends 50% of collected BNKR to its staking destination and queues the remainder for guarded BNKR-to-USDC conversion. Today that destination is the Safe; it does not itself stake. This proposal changes only that destination to a new `StakedBankrStakingAdapter` after the distributor's existing 48-hour configuration delay.

The adapter stakes fee principal in Bankr's newer BnkrStakingV3 program. The protocol's stake belongs to the adapter, controlled by the Safe; individual STAKED depositors do not receive transferable Bankr staking positions or a claim on its principal. Only earned BNKR is harvested and forwarded through the existing `StakedRewardRelay` into the existing V3 vault's BNKR stream. STAKED balances, locks, and accrued claims stay in place. Personal Bankr assets/positions are outside this integration.

## External contract evidence

- Official app: https://bankr.bot/stake
- Official public overview: https://api.bankr.bot/staking/overview
- Base staking contract: `0x88470240FF0663Faefa68B1D7621b472DdD9584A`
- Sourcify: https://sourcify.dev/server/v2/contract/8453/0x88470240FF0663Faefa68B1D7621b472DdD9584A?fields=all
- Verified contract: `src/BnkrStakingV3.sol:BnkrStakingV3`, solc 0.8.25, optimizer 200, viaIR, Cancun. Sourcify reports exact runtime match and no proxy.
- Read at Base block 52009577: live runtime exactly matched Sourcify on-chain bytecode; hash `0xd5aed805076ee0ed5e564daf83ae17fbe099347b87d443db69159571c87e21c3`. `stakingToken` and `rewardsToken` both BNKR; pause false; cooldown 172800 seconds. Distributor staking destination was the Safe.
- Older Bankr documentation calling staking withdraw-only refers to an older program and must not determine the new adapter interface.

The external program accepts contract callers, uses `stake(uint256)`, `getReward()`, `requestUnstake(uint256)` and `withdraw()`. Rewards and principal use the same token. `getReward()` sends rewards to its caller; it does not auto-restake or withdraw principal. `withdraw()` only returns mature cooldown principal. We measure token balance changes instead of trusting either return value.

## Authority and accounting

- Immutable Safe, BNKR, staking contract, and relay. No arbitrary calls or recipient choices.
- Initially paused, operator zero, limits zero. `setPolicy` is Safe-only and delayed 48 hours, including subsequent changes/rotation. Safe can pause or restart; operator can pause only.
- Proposed pilot policy: **120,000 BNKR maximum per deposit, at most one deposit per 24 hours; 240,000 BNKR total staked plus cooling**. These are proposed ceilings, not transfers. At the exposure ceiling, new fee principal stays idle until Safe changes policy or recovers principal. Policy changes do not reset timestamps or spending history.
- Harvest at most once per 24 hours when it pays a positive reward. Failed or zero harvests do not suppress a later valid harvest. Claimed yield is reserved separately and cannot be staked or swept as principal.
- Relay all reserved yield at most once per 24 hours. Claims and forwarding are separate transactions, so unavailable vault forwarding need not block reward collection. A relay revert preserves the yield reservation and approvals by atomic rollback.
- Deposits use exact approval, zeroed after consumption. Yield forwarding does the same. No wallet allowance is required by the adapter, and no function pulls from a wallet.
- Pausing stops new deposits; harvest, relay and Safe principal recovery remain available. If reward forwarding itself must stop, the Safe disables this adapter with relay.setYieldSource(adapter,false).
- Only Safe can start unstaking, while paused. Principal remains counted against exposure during Bankr's 48-hour cooldown. Mature withdrawals always return to the immutable Safe. Idle principal can also return to Safe while paused, excluding reserved yield. No cancel/re-stake or arbitrary rescue route exists for BNKR.
- All external staking mutations check its deployment code hash. Bankr's own pause, reward funding and operational availability remain external risks; no guaranteed APR.
- Adding principal dilutes the Bankr position's time-weighted multiplier. Unstaking burns its points proportionately. This does not change STAKED users' existing vault lock rules.

## Build and validation

```
npm ci
npm run test:bnkr
ANVIL_BIN=/path/to/anvil BASE_FORK_BLOCK=52009577 npm run test:bnkr:fork
```

Unit tests cover actual V3 vault/relay reward delivery and claims, hostile return values, failed relay recovery, cleared approvals, withdrawal cooldowns, access controls, pause/restart, daily intervals and aggregate exposure including cooling. Fork tests require a loopback Anvil, pin the Base block and code hash, use the real deployed staking/distributor/relay/vault, and locally impersonate Safe authority. They do not demonstrate real Safe signatures or live automation. Read `build/bnkr-fork-report.json` only after a successful run; absence means fork validation is incomplete.

Validation completed September 30, 2026: solc 0.8.24 compilation and all 30 unit checks pass. The local Base fork at block 52009577 passes 22 checks, including real Bankr stake/harvest, existing relay/vault reward delivery, Safe-only cooldown recovery, delayed routing rollback, and planner rejection of wrong operator, changed policy, stale plans and altered calldata. Evidence is in `review/bnkr-staking-validation.json`. The first cold-cache attempt timed out; the completed run used cached, pinned upstream reads. This is a local rehearsal, not a live deployment or Safe signature test. GitHub staking and public-app CI passed the initial implementation revision; check the PR checks for the latest revision.

## Deployment and activation (after review)

1. Review this revision, especially principal ownership, proposed ceilings and recovery. No financial action is included in this document.
2. Build with pinned dependencies. The read-only builder accepts the actual Rabby deployer and current pending nonce:
   `node scripts/prepare-bnkr-staking.mjs DEPLOYER NONCE`.
   It checks a pinned snapshot and writes a review-only proposal. Regenerate if the deployer nonce changes. It does not sign/broadcast and does not verify its own deployment.
3. Deploy one adapter from Rabby. Verify runtime bytecode/immutables, Safe/token/staking/relay addresses, zero operator/limits and paused state. Register/verify source before activation.
4. Safe batch: schedule adapter policy and distributor staking-destination change. Both require **48 hours after the scheduling transactions execute**, not after preparation. Each expires seven days after maturity.
5. After the delay, re-read and simulate the exact activation batch: set adapter policy; authorize adapter as relay yield source; change only distributor.bnkrStakingWallet to adapter; unpause adapter. The underlying V3 vault and USDC keeper are unchanged. Check Safe execution success and every post-state field.
6. Update the existing Bankr automation to a reviewed pinned commit with this additional workflow; retain all existing conversion protections. Pause/cancel and recreate as needed so no duplicate jobs exist. Do not tell it to repair mismatches.
7. First funding comes from future fee collection. Previously accumulated fee BNKR in Safe is not transferred by the builder. Review its provenance and exact amount separately if desired. Never use the personal Bankr staking position as funding.
8. Simulate and verify a small first stake, subsequent real harvest, relay receipt, and vault reward accounting before claiming the full integration is live.

## Automation additions

Run existing collection and guarded conversion as before. Then verify chain, adapter runtime/immutables, operator, policy, source code hash, distributor staking wallet, all four existing relay relationships, relay yield-source permission, and unresolved submissions. Re-read before each send; use exact helper selectors only, zero ETH, no arbitrary target/calldata, no approvals from operator.

- If the Bankr pool is behind, call `advanceStaking` in bounded batches (1..180 days) and re-read; do not replace pinned reads with latest to hide a mismatch.
- Stake `min(idlePrincipal, maxStakePerDay, maxPrincipal - activeStake - coolingPrincipal)` only if positive, unpaused and 24h interval elapsed. Simulate. External pause/error means skip and report. Never lower protections or stake pending yield.
- If harvest interval elapsed and Bankr earned(adapter)>0, simulate and call `harvest()`.
- Re-read pendingYield and relay cadence; simulate and call `relayYield()` when positive/eligible. On failure keep rewards reserved and report. Never forward principal to the reward vault to make a test pass.
- Verify receipts and exact principal/reward balance changes. Resolve unknown transactions before retry. At most one stake, harvest and relay per scheduled run; never call withdrawal or configuration functions.

## Recovery

Pause new adapter deposits immediately. Existing USDC conversion and fee collection may continue; BNKR for staking accumulates idle in the paused adapter. Safe can return idle principal and request unstaking without waiting for an administrative timelock; Bankr still enforces its 48-hour cooldown. Withdraw mature principal to Safe. Claim/relay outstanding rewards separately.

For destination rollback, schedule `distributor.setBnkrStakingWallet(Safe)`, wait 48 hours, execute and verify. Disable the adapter's relay permission only when necessary; otherwise harvest remaining earned BNKR after exiting. Existing pending yield must be relayed, not rescued as principal. A replacement adapter requires a new reviewed deployment and delayed routing change.

## Prepared review package

See `review/BNKR-STAKING-REVIEW.md` for the implementation review and exact CI evidence. `review/bnkr-unsigned/` contains unsigned creation/scheduling/activation data prepared for Rabby nonce 217, with a successful Base creation simulation. `bnkr-deployment/` contains a one-contract signing page, not yet hosted or used. Contract code remains pinned to revision `d16ecaedab1149971f834fcb21623ed03f1fc0bd`. Revalidate the nonce and state before any use.
