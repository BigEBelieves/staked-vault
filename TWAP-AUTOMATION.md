# Automatic BNKR fee conversion

`StakedTwapKeeper` replaces only the distribution side of the expiring-policy
guard. The existing collector, distributor, relay and staking vault remain in
use. Buybacks continue to use the old paused guard. This is a new, unaudited
contract; tests are not an independent security audit.

## Operation

1. A recurring operator calls the existing collector's `collectAndDistribute()`.
   Anyone can trigger collection; its destination and split are fixed by the
   existing contracts. Collection does not need a Safe signature.
2. Read the distributor's full pending BNKR queue. Wait if it is below the
   existing minimum batch, above a configured cap, or still in cooldown.
3. Use `prepareTwapKeeper` in `scripts/twap-keeper-plan.mjs` to read a pinned
   block, quote the BNKR/WETH/USDC route, calculate the stronger of the fresh
   quote minimum and the on-chain floor, and simulate the exact keeper call.
4. Revalidate immediately before submitting that exact call from the operator.
   The contract independently checks prices and limits at execution. The
   planner never loads keys, signs or broadcasts. A successful simulation does
   not guarantee execution after state changes.

An operator needs ETH for gas, but no token balance or token approval. Only
`swapAndNotify` and emergency pause are authorized operator actions. The keeper
has no withdrawal, token-approval, arbitrary-call or buyback function.

## On-chain checks

Both pools must come from the configured canonical Uniswap V3 factory, with
the exact tokens and 1% / 0.05% pool fees. Quotes subtract these pool fees before
applying the permitted slippage discount; fees are distinct from slippage.

- 1-hour and 5-minute tick averages; missing history reverts.
- Pairwise spot/short/long deviations limited to at most 100 ticks per pool
  (approximately 1%). This is a per-pool comparison, not a promise that total
  execution is within 1% of an external market price.
- Latest pool observation no older than 30 minutes. An inactive pool can stop
  automation even when its last price is reasonable.
- Minimum current and 1-hour harmonic liquidity for each pool.
- Input-size limits at most 0.2% of conservative virtual input reserves on each
  leg. Concentrated liquidity can change across ticks; this bound is not an
  exact price-impact guarantee. The final output floor remains mandatory.
- The higher of the two complete-route TWAP outputs sets the reference, with
  a Safe-configured discount no greater than 1%, rounded up.
- Full-queue binding, per-swap cap, exact rolling 24-hour cap, minimum interval,
  short deadline and replay nonce. Spending history survives reconfiguration.
- Existing distributor owner, operator role, router, tokens, fees, relay and
  payout addresses must match before any swap.

The 24-hour budget renews as earlier trades leave the rolling window. No
hourly Safe price renewal is needed. Initial limits are selected in the private
deployment handoff and must be checked against current prices and liquidity.

## Changes later

The Safe can pause/unpause, appoint or disable an operator, and change spending,
liquidity, interval and permitted price/size limits within the contract's hard
bounds. Updating limits requires pausing first; these can be one atomic Safe
batch. The operator can pause, but cannot unpause or change limits.

The code, tokens, route, oracle windows, factory, Safe authority and destinations
are immutable. To change these, deploy a replacement and have the Safe change
the distributor's keeper. A replacement does not require moving user stakes.
As with other Safe-controlled settings, two compromised Safe signers could
replace the keeper and bypass its restrictions.

## Limits of unattended operation

TWAPs from the traded DEX pools are not independent price feeds and can be
manipulated. Public submission still exposes orders to MEV. Spending caps,
liquidity checks and mandatory floors reduce exposure; they cannot eliminate
losses or guarantee execution. This path does not require a private-RPC account.

The original distributor swaps the entire queue, not a partial amount. If
collection or a donation grows that queue above the cap, the keeper stops until
the Safe reviews an appropriate limit or another solution. Do not silently
raise limits or fall back to calling the distributor directly. Rapid price
moves, stale observations, low liquidity, failed quotes and RPC failures also
mean skip and report, never weaken protection.

A daily Bankr agent-command schedule can automate collection and checks.
Bankr currently documents a 1,000-run lifetime maximum per agent automation:
monitor the remaining runs and renew the schedule when necessary. The schedule
has not been created by this repository. There is no Bankr signing integration
in these scripts. Use the correct operator wallet and verify the created job.
See https://docs.bankr.bot/agent/automations/ .

## One-time setup

Compile from the reviewed source, set a read-only `BASE_READ_RPC_URL`, and use:

```sh
node scripts/prepare-twap.mjs plan DEPLOYER /private/keeper-deployment.json
node scripts/prepare-twap.mjs verify /private/keeper-deployment.json CREATION_HASH
node scripts/prepare-twap.mjs batch /private/keeper-deployment.json CREATION_HASH /private/limits.json /private/safe-activation.json
```

Keep the generated files private. The single-helper page at `twap-deployment/`
accepts a local deployment file; it does not upload the file or open a wallet
request on load. Every creation requires a user click and wallet approval.
After successful creation, regenerate the Safe batch against current state and
simulate it in Safe. It removes the old guard's operator, configures the new
keeper, assigns only the distributor to it and unpauses only the new keeper.
The old guard stays paused. The batch does not change ownership or fee splits.
Setup does not itself create a recurring Bankr job.

The preparation script simulates `setLimits` as an inner Safe call, overriding
only the Safe's native ETH balance for simulation gas. It does not simulate
Safe signatures or the complete activation; those are checked separately in
the local fork and in Safe before execution.

The limits file contains all eight fields of `StakedTwapKeeper.Limits`.
Use decimal strings for the four uint128 fields and integer numbers for the
interval and bps/tick fields. No default production spending caps are assumed.

## Tests

`npm test` includes the keeper's authority, oracle, spending and arithmetic
tests and read-only planner tests. `npm run test:twap-fork` uses a strictly
loopback Anvil fork with a read-only upstream. No live sends are possible in
that test. It exercises the actual Safe, collector, pools, tokens, distributor,
relay and vault. Locally funded ETH buys BNKR for a donation fixture; this tests
collector forwarding, not newly accrued pool-fee payout. Buybacks are not run.
Fork reports stay outside the repository unless explicitly requested.
