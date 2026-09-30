# V3 read-only Base-fork rehearsal

This validation branch runs only on `validation/v3-base-fork`. It has no main
branch, website, contract deployment, wallet signing or scheduler step.

The workflow installs locked Node dependencies and Anvil 1.7.1, compiles the
contracts, tests the public-summary filter, then performs the migration on a
loopback-only Base fork. An initial read-only preflight selects one public
provider and pins a block. Preflight requires contract reads and historical
depositor logs; a provider that rejects either is not selected. The provider
remains fixed for the entire run. Historical logs use complete pages of 2,000
or 100 blocks, whichever passes preflight. The read proxy spaces upstream
requests by at least 1.1 seconds and backs off further for transient rate limits.
The upstream proxy denies write methods. All Safe approvals, contract creations,
asset movements, impersonation and time changes occur only on local Anvil.

The rehearsal verifies constructor wiring, later protected configuration delays,
old reward preservation, opt-in stake migration, fee cutover, guarded partial
conversion after outsider dust, rollback and redemption. The new keeper begins
paused with no operator. The initial setup requires no two-day delay; future
listed core changes retain their 48-hour delay.

GitHub permissions are `contents: read`; checkout does not persist credentials.
The workflow takes no wallet keys, secrets, RPC credentials or signing files.
Third-party actions are pinned to reviewed commit hashes. Node is pinned to
24.19.0 and the native Anvil package has a lockfile integrity value.

Public logs contain static stage/check labels and a minimal success summary.
The full snapshot, balances, private report, predicted deployment calldata and
raw failure logs stay on the ephemeral runner and are not uploaded. A failed
run prints its stage and a generic failure classification; it never produces a
successful summary. Report checks require actual old/new claim preservation,
principal redemption and a guarded swap above the minimum.

A successful result covers the simulated fork only. Fresh deployment state,
actual live receipts, wallet signatures, complete live Safe simulation and
scheduled-job verification are still separate release requirements. This
workflow cannot approve or perform a live deployment.

## Migration review follow-up

The V3 keeper now immutably binds the existing keeper. Its rolling spend includes
both histories, and its execution interval uses the later trade timestamp.
Unpause and swaps require the predecessor to stay paused with no operator.
Remaining aggregate budget can be used after the normal interval; no blanket
24-hour migration wait is introduced. The legacy keeper is non-upgradeable and
its runtime/identity is checked by the migration planner.

Receipt/runtime/immutable verification is separate from cutover configuration
checks. Rollback supports legitimate changes such as the delayed batch threshold
or router update. Its four calls pause/remove the new operator, return beneficiary
rights and collector-held tokens to the Safe, then restore old collector rights.
Recovery does not call the distribution route. Existing queues and claims stay
in their contracts, and both trading paths stay disabled. Restarting old trading
requires a fresh aggregate-budget decision.

The manifest version is now 3; regenerate and review all earlier unsigned data.
The regression suite tests exact 24-hour expiry, cross-keeper interval, exhausted
and partial aggregate budget, reconfiguration, and predecessor reactivation.
The fork additionally makes a real legacy swap before cutover and exercises
Safe rollback after supported 48-hour-delayed configuration changes. See the
Actions run for this exact commit for its results; no live transactions are sent.
