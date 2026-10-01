# Recoverable founder BNKR sponsorship

Status: implementation candidate, not deployed or funded. No personal position was unstaked. The existing fee adapter, its pending activation, the distributor, the vault and Bankr automations are unchanged.

## Agreement represented by the code

The sponsor contributes BNKR principal to a **separate** staking position. Actual earned BNKR goes through the existing reward relay to STAKED stakers. The sponsor can permanently stop new funding/staking and recover their remaining principal to an immutable sponsor address. This is withdrawable sponsorship, not a permanent treasury donation or locked liquidity. Already distributed rewards cannot be reclaimed.

`StakedBankrSponsor` is separate from `StakedBankrStakingAdapter`. Do not send fee allocations to the sponsorship contract. It uses the same verified external Bankr interface and measured balance deltas, but has its own daily cap, exposure, cooldown and yield accounting. Caps are independent across the two positions; review their combined external-program exposure before funding.

## Funding and separation

Only the immutable sponsor can call `fund(amount)`. It pulls an exact amount of BNKR from that sponsor using an allowance; use exact approvals. Idle registered principal, active stake, cooling principal and pending yield are distinct. The invariant is:

`principalOutstanding = fundedIdle + external stakeOf(sponsorContract) + coolingPrincipal`

The local token balance equals funded idle principal plus pending yield plus uncredited surplus. Ordinary token transfers do not create sponsor credit. Only funding registered through `fund` is recoverable as sponsor principal. Accidental BNKR transfers may be returned to the Safe as surplus while paused; they cannot be staked or described as earned yield.

Deposits, staking and configuration retain 48-hour delayed policy changes, per-deposit/daily-interval limits, measured external stake changes and exact cleared allowances. Claimed rewards cannot be staked, returned as principal or swept with rescue. Harvest/relay failure preserves all accounting atomically.

## Sponsor recovery

1. Sponsor calls `beginExit()`; no Safe signature or administrative delay is required. This permanently sets exiting and paused. Safe cannot undo it, even by changing policy.
2. Sponsor calls `returnIdlePrincipal(amount)` for registered uninvested capital. It always pays the fixed sponsor address.
3. Sponsor calls `requestUnstake(amount)` for active principal. External Bankr cooldown and restrictions apply; principal is counted while cooling.
4. Once Bankr permits withdrawal, sponsor calls `withdrawPrincipal()`. The measured returned principal goes to the fixed sponsor address, never the operator or Safe.
5. Keeper or Safe can continue harvesting and relaying earned rewards after exit. Safe may assist recovery but cannot redirect principal. Disabling the relay does not prevent principal withdrawal.

An exit closes that contract to new contributions permanently. Future sponsorship would need a separately reviewed deployment. The sponsor address cannot rotate. Loss/compromise of its keys is a risk; Safe can assist return only to that same address. Safe retains control of policy and yield-source permission; the sponsor cannot force the Safe to keep relaying rewards. Withdrawal availability depends on Bankr and BNKR continuing to behave as expected. Code-hash checks fail closed if external staking code changes. This is not insured or guaranteed principal.

## Before deployment or a personal unstake

- Obtain review of this contract and its accounting/recovery tests.
- Select the sponsor return wallet and exact contribution amount with Eric. No default to the hot Bankr wallet; no assumed contribution of the entire personal position.
- Re-read current Bankr terms, cooldown, stake balance and lost multiplier/points. An old read is not sufficient for a financial decision.
- Finish the historical Base-fork rehearsal, then verify fresh deployment state and source before funding.
- Deploy separately from Rabby after review; immutable parameters are Safe, BNKR, Bankr staking, existing relay, sponsor return wallet.
- Schedule a dedicated policy through the existing 48-hour mechanism and wait for maturity. Review the caps across both adapters.
- Safe authorizes only this new yield source; it does not reroute protocol fees. Activate the reviewed policy and unpause after exact-call simulation.
- Prepare an explicit small exact approval/funding test followed by stake, harvest, relay and recovery checks. No deployment or activation payload is prepared in this candidate because the sponsor address/amount have not been chosen.
- Sponsorship automation and a signing UI must be prepared and reviewed separately. Existing fee automation cannot silently substitute this contract for the fee adapter.

## Tests and scope

`npm run test:sponsor`: 51 local EVM checks passed on the implementation candidate. Tests deploy the real repository V3 vault and reward relay with mocked BNKR and Bankr staking. They cover funded/active/cooling principal conservation, measured yield, separate surplus, rejected relay recovery, cleared approvals, sponsor and Safe return paths, unauthorized access, cooldown, permanent exit, claims by a STAKED staker, and changed external code hash. The existing fee adapter suite also passes all 30 checks.

`ANVIL_BIN=/path/to/anvil BASE_FORK_BLOCK=52009577 npm run test:sponsor:fork` rehearses the real Bankr program and deployed relay/vault on an isolated historical fork. All writes target loopback Anvil; upstream RPC accepts reads only. Sponsor/Safe signatures are impersonated locally. This is not a live transaction or a current-state guarantee. See `review/bnkr-sponsor-validation.json` for whether that run completed.
