# Deployment tooling — helpers deployed, wiring pending

The four helpers were deployed on Base on September 29, 2026. See [DEPLOY.md](DEPLOY.md)
for the confirmed addresses and source verification. Do not repeat the creation transactions.
The remaining CLI workflow prepares unsigned Safe configuration batches.


This package prepares four direct contract-creation transactions, verifies their receipts and
runtime code, and then generates separate Safe Transaction Builder files for wiring, fee rights,
and rollback. It never reads a private key, signs, proposes a Safe transaction, or sends a transaction.

The existing vault and user stakes stay in place. All four helpers are permanently controlled by
Safe `0xb9066550918fa778a4039120eac878230cf8f6fc`. Initial wiring leaves the guard paused, operator
unset, and budgets empty. No activation or price-policy batch is generated.

## 1. Freeze and review the build

Use the reviewed commit of this branch and a clean checkout:

```sh
npm ci
npm test
ANVIL_BIN=/absolute/path/to/anvil npm run test:fork
```

Review [REVIEW-HANDOFF.md](REVIEW-HANDOFF.md). Keep the commit ID, `package-lock.json`,
`config/base.json`, and generated `build/standard-input.json` with the deployment record.
The standard JSON file contains the exact source and compiler settings for source verification:
Solidity **0.8.24**, optimizer **200**, EVM **Paris**. Each helper has its own contract name and
constructor arguments in the plan. Publish and verify all four sources after deployment.

### Optional deployment-only Rabby page

The separate [`deployment/`](deployment/) utility supports one wallet-approved creation at a time
from the pinned plan. It simulates each creation and verifies receipts/code before enabling the next.
It permits deployment of inactive helpers before independent review; it does not perform the live
Safe migration or activate trading. Review remains outstanding, and deploying code does not certify
its safety. See its README for recovery behavior and the exact source commit pinned in the payload.

## 2. Prepare deployment calldata

Use a separate ordinary EOA that can send **direct CREATE transactions** on Base. It only needs
gas; it receives no ownership or token approval. This workflow rejects a Safe, factory, delegated
EIP-7702 account (including the current Bankr account), or account-abstraction deployment flow.
Do not export the Ledger seed or any wallet key. Use the wallet's normal signing interface.

Set `BASE_READ_RPC_URL` locally to a trusted Base read endpoint. This setting is for reads only;
it does not establish private submission or select the wallet's eventual write provider.

```sh
npm run prepare:deployment -- plan YOUR_DEPLOYMENT_WALLET deployment-plan.json
```

Replace `YOUR_DEPLOYMENT_WALLET` with its public `0x` address. The command checks chain 8453,
ordinary-account code, absence of pending transactions, and unused predicted contract addresses.
The output contains four unsigned creations with explicit nonces and constructor calldata:

1. Reward relay.
2. Automation guard.
3. Bounded executor, bound to the predicted guard.
4. Fee collector.

These addresses are **predictions**, not evidence of deployment. Have the deployment tool review
and send the four creations in order, one confirmed successful receipt at a time. Each sends zero
ETH to the constructor; normal network gas still costs ETH. Estimate gas with the chosen wallet.
The plan is not a Safe import file. Do not set a `to` address or wrap these in a wallet/factory call.

Reserve those four nonces. If another transaction uses a nonce, a creation reverts, or the wallet
changes its deployment method, stop: regenerate the remaining deployment strategy and review it.
Do not wire addresses from a failed plan. The automated verifier supports an intact four-creation
plan; partial/replacement deployments require a separately reviewed plan.

## 3. Verify actual deployments

Create `deployment-hashes.json`, a JSON array containing the four successful Base transaction
hashes in the order above. Then run:

```sh
npm run prepare:deployment -- verify deployment-plan.json deployment-hashes.json
```

The verifier reconstructs the plan from the current build, checks canonical successful receipts,
sender/nonces, direct CREATE, zero constructor ETH, exact creation bytecode/arguments, predicted
addresses, runtime bytecode and all immutable public settings. It checks the executor's pool key.
Solidity's immutable runtime slots are masked only for the code comparison; exact constructor
calldata and getter checks authenticate their values. This is not explorer source verification or
an audit of the original contracts, token proxies, router or hook.

## 4. Generate and execute the paused wiring batch

```sh
npm run prepare:deployment -- batch wire deployment-plan.json deployment-hashes.json safe-wire.json
```

The command refuses unexpected ownership, a non-2-of-3 Safe, Bankr as a Safe signer, changed
fee shares, nonzero Bankr allowances, changed distribution routes, active keepers, or previously
configured helpers. It checks the deployed MultiSendCallOnly code hash. It generates ten zero-ETH
calls, including both sides of the reward-relay wiring in the same batch.

In the **Base Safe**, open Transaction Builder, import `safe-wire.json`, review the ten decoded
calls against [SECURITY-MIGRATION.md](SECURITY-MIGRATION.md), and simulate the complete batch.
Obtain two owner approvals and execute. A successful simulation alone is not execution.
After a successful Base receipt, re-read both legacy keepers (guard), both reward links (relay),
both executor references (new executor), payouts (Safe), and guard pause/operator/budgets
(true/zero/zero). Ownership and pending BNKR must be unchanged.

The generated `.verification.json` records the snapshot, Safe nonce, owners, deployment receipt
hashes, runtime hashes, and batch-file hash. The Safe nonce is observational, not an enforced
precondition in the batch. Regenerate close to execution and check for intervening Safe actions.
The snapshot can become stale; the JSON checksum is a consistency check, not a signature.

## 5. Generate a separate fee-beneficiary batch

Only after the wiring receipt and source checks:

```sh
npm run prepare:deployment -- batch fees deployment-plan.json deployment-hashes.json safe-fees.json
```

This refuses unwired helpers or an enabled operator. It first collects the Safe's accrued fees,
then moves its 95% beneficiary share to the verified collector. Import, review, simulate and execute
with two Safe approvals. Previously settled tokens stay in the Safe. Verify shares: collector 95%,
Safe 0%, Bankr 0%, existing other beneficiary 5%. Test collector payout and zero allowances.

No scheduled swap job should start at this point. Activation still needs independent contract
review, independently reviewed price references/budgets, the private-submission checks in
[PRIVATE-SUBMISSION.md](PRIVATE-SUBMISSION.md), and one small signed trial.

## Emergency rollback

```sh
npm run prepare:deployment -- batch rollback deployment-plan.json deployment-hashes.json safe-rollback.json
```

It pauses the guard, removes its operator, zeros both legacy keepers, returns collector fee rights
if it holds them, and restores the original reward links. It leaves the bounded executor installed;
it does not re-enable the legacy swap weaknesses. Review and simulate before Safe execution.

The generator requires readable verified contracts and recognized fee ownership. If that check
fails during an incident, use the individually reviewed emergency calls in the migration runbook;
do not wait for a full rollback to pause. The operator can call `guard.setPaused(true)` immediately.

Output files are never overwritten. Use a fresh filename after each regeneration. No endpoint
secrets are saved to any generated plan or verification file. Keep receipts and reviewed outputs
with the eventual production deployment record; the fork test's addresses must never be used live.
