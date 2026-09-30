# BNKR staking integration: pre-deployment review

Reviewed contract revision: `d16ecaedab1149971f834fcb21623ed03f1fc0bd`.
Date: September 30, 2026. Reviewer: Codex, also the implementation author.
This is an implementation review, not an independent audit or external approval.

## Result

No blocking issue was identified in this review of the adapter's authority,
principal/yield accounting, external staking interface, and delayed activation.
At the time of this pre-deployment review, the adapter had not been deployed. For subsequent deployment status, see `bnkr-live/`. Existing automation and live assets were not
changed. An independent reviewer has not submitted a GitHub review on PR #3.

The review checked the adapter against the verified Bankr `stake`, `getReward`,
`requestUnstake`, and `withdraw` implementations, including their reward settlement
and cooldown behavior. Principal transfers are separate from reward claims.
The adapter does not grant delegated claiming rights.

## Checks and boundaries

- Immutable destinations bind staking to Bankr, reward delivery to the existing
  relay, and principal recovery to the Safe. No arbitrary call or recipient input.
- Only the Safe can request unstaking or return principal; the operator can pause
  deposits but cannot restart them, change policy, or recover principal.
- Claimed yield is measured by BNKR balance change and reserved separately.
  The Safe cannot sweep this reservation through the principal recovery functions.
- Exact token approvals are cleared after staking and forwarding. Reverts roll back
  transfers, reservations and approvals together.
- Active and cooling principal count toward the exposure cap. Safe policy changes
  do not reset deposit/claim/relay timestamps.
- Both initial policy and distributor destination require the existing 48-hour
  delay. Bankr's separate withdrawal cooldown cannot be bypassed by the adapter.
- Current vault deposits, lock state and existing claims remain in the V3 vault.
  The existing USDC conversion queue and protections remain in place.

## Operational choices to review

The proposed pilot ceilings are 120,000 BNKR per deposit, one deposit per 24 hours,
and 240,000 BNKR active plus cooling. Once the exposure ceiling is reached,
additional fee principal stays idle. Increasing these ceilings needs a delayed
Safe policy change and a corresponding reviewed automation configuration update.

Intervals are elapsed 24-hour periods, not calendar days. A daily job that starts
earlier than the previous day's successful action may skip that action until the
next run. The runner must report skips; it must not shorten the interval.

The principal belongs to the protocol's Safe-controlled adapter. STAKED depositors
receive streamed staking yield, not an individual claim on Bankr staking principal.
The external program controls its reward funding and can pause new deposits.
Neither reward availability nor a rate of return is guaranteed.

## Evidence

- 30 unit checks passed.
- 22 local Base fork checks passed at block 52009577, including real Bankr reward
  payment, forwarding into the existing vault, cooldown recovery, delayed routing
  rollback, and planner rejection cases.
- GitHub Actions for the exact reviewed revision both succeeded:
  [BNKR staking adapter](https://github.com/BigEBelieves/staked-vault/actions/runs/36789718116)
  and [Public staking app](https://github.com/BigEBelieves/staked-vault/actions/runs/36789718089).
- Machine-readable local evidence: `bnkr-staking-validation.json`.

## Remaining gates

1. Review the exact contract revision and proposed policy before deployment.
2. Refresh the unsigned deployment package if Rabby's nonce or chain state changes.
3. After deployment, verify the exact creation transaction, runtime and all immutable
   getters; require paused state, zero operator, zero limits and no staking exposure.
4. Simulate and execute the Safe scheduling batch, then record each on-chain ready time.
5. After 48 hours, re-read state and simulate the exact activation batch before signing.
6. Update the automation only after verified activation. Check the first live stake,
   harvest and relay before describing staking yield as operational.

Unsigned scheduling and activation JSON are preparation artifacts, not execution
evidence. Do not import or sign an activation batch merely because its file exists.
