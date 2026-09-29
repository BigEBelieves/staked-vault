# V3 read-only Base-fork rehearsal

This validation branch runs only on `validation/v3-base-fork`. It has no main
branch, website, contract deployment, wallet signing or scheduler step.

The workflow installs locked Node dependencies and Anvil 1.7.1, compiles the
contracts, tests the public-summary filter, then performs the migration on a
loopback-only Base fork. An initial read-only preflight selects one public
provider and pins a block. Preflight requires contract reads and historical
depositor logs; a provider that rejects either is not selected. The provider
remains fixed for the entire run. Historical logs use complete 100-block pages,
and the read proxy paces requests and retries transient rate limits.
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
