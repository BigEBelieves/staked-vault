# STAKED Vault skill for Bankr

This package adds instructions and a read-only, dependency-free Python planner for users staking their own STAKED in the deployed V3 Base vault. It is separate from protocol-owned BNKR staking, treasury, and automation.

## Install and first test

Use Bankr terminal to install the skill from the immutable GitHub revision linked in the review PR, folder `skills/staked-vault`. Bankr documents GitHub-folder skill installation at https://docs.bankr.bot/skills/in-bankr/from-github/.

Then ask:

> Use the staked-vault skill to show my authenticated Bankr wallet's STAKED balance, V3 stake, unlock time, and pending USDC/BNKR rewards on Base. Read only. Do not approve, stake, withdraw, claim, or submit any transaction. Confirm whether you can run the bundled Python planner and preserve operation records for later transaction reconciliation.

Installation in terminal does not establish support for public @bankrbot mentions on X. Bankr must confirm that separate capability. Do not advertise live staking through Bankr until its actual execution capabilities and an explicitly authorized small test have been verified.

## Validation evidence, 2026-10-01

- 27 Python tests passed: exact decimal handling, bounded amounts, allowance reduction, approval/stake separation, wrong chain/contracts, lock boundaries, all-reward forfeiture, read-only preview, claim restrictions, RPC method allowlist, pinned reads, stale snapshots, code mismatch and reorganization rejection.
- Vault runtime from prior `initial-stake-code.json` deployment evidence matched compiled `StakedVaultV3` outside Solidity immutable slots. Planner separately verifies immutable token getters and rules. Token clone runtime is fingerprinted, not audited.
- Fresh live Base reads were unavailable in this execution environment. The manifest uses the existing deployment evidence, explicitly labeled. Bankr must obtain fresh matching reads before any plan.
- Forward review identified the missing pre-consent penalty preview. Added `preview-early-withdraw`, with no transaction, and regression tests.
- No live transaction, approval, automation change, deployment, or Bankr installation occurred in this build.

Run locally: `python3 -m unittest discover -s test -p bankr_skill_test.py -v`.

## Execution boundaries

The Python CLI is the supported planner interface; output base-unit balances are decimal strings. It contains no signing or sending method. For the current supervised mode, Bankr must provide authenticated wallet resolution, permitted contract submission, fresh eth_call, persistent audit records and receipt/execution reconciliation. Dedicated operation-ID and pending-list tools are not prerequisites; the supervised procedure explicitly documents their absence and the remaining concurrency risk. If a capability is absent, stop; do not improvise a workaround. These instruction-level protections are not enforced by a new smart contract.

Every spending step requires user authorization. Use exact approvals, confirm receipt, regenerate after approval, and serialize per wallet. Unknown submission outcomes block retries. Changes are limited to this skill, its tests, CI and documentation; the public app and deployed contracts are unchanged.

## Bankr installation feedback and transport revision

Bankr installed the first revision but omitted the JSON fingerprint file. Python started successfully, but its TLS trust store and subsequent HTTP 403 responses blocked the live snapshot. No vault status or execution capabilities were established.

Revision 1.1 embeds fingerprints, explicitly links package files, uses verified Python TLS with an optional trusted CA bundle, and adds an opt-in verified curl POST transport. It does not assume curl GET success proves POST access, change providers automatically, retry 403s or bypass access controls. The JSON audit copy remains for review. Nine additional packaging/transport tests bring the total to 36. Live Bankr read-only validation is still required.

## Supervised revision 1.2

Bankr successfully ran status on the real user wallet at block 52034664 using verified curl HTTPS. Receipt lookup and eth_call work. User files persist by tool documentation and passed same-session read-back; cross-session retention was not independently verified. They have no atomic lock. Support's AI reply confirmed raw submission is documented but idempotency/recovery guarantees are not.

The user authorized a supervised revision: per-step consent, exact approval then separately confirmed stake, fresh eth_call, persistent pre-submit stop markers, one attempt, and no automatic retry. Unknown submissions block further writes. This deliberately replaces the original requirement for Bankr-specific simulation/operation-ID/pending-list tools. It does not claim concurrent safety or automatic recovery. See skills/staked-vault/references/supervised.md.

No contract, public website, automation or fund changes. Existing 36 planner/transport tests are rerun. Instruction-level workflow is scenario-reviewed; no live submission is tested or authorized by installation.

Forward review covered six scenarios: successful approval then deposit, missing-hash timeout, post-submit journal failure, a second chat finding SUBMITTING, bundled inner-call failure, and expiry during journal writes. Review found ambiguous expiry restart and journal-update wording; both were corrected. This is instruction review, not proof of Bankr execution behavior.
