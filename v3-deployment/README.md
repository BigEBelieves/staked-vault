# V3 deployment signing page — unpublished review

This page deploys the five reviewed V3 contracts on Base, one explicit Rabby
approval at a time. It does not perform Safe activation, move beneficiary rights,
withdraw or restake assets, or modify automation. No plan or private accounting
snapshot is embedded in its public assets.

Contract source: `19210c9d613665a0fcb1615a4e41436fdf2f90c1`.
The final contract rehearsal passed 84 checks in GitHub run `36650740916`.
This signing interface is separate new work. Browser tests use a simulated wallet;
they do not sign or broadcast live transactions.

## Preparation and build

Run `npm ci --ignore-scripts`, then `npm run build:v3-page`. The build verifies
`reviewed-build.sha256` before generating the locally bundled JavaScript and its
SRI hash. That pin binds the reviewed artifacts and protocol configuration.
Do not update the pin to bypass a mismatch: review any source/config change first.

Use `scripts/prepare-v3-migration.mjs plan DEPLOYER OUTPUT_DIRECTORY` with a
read-only Base RPC to obtain a new `deployment-plan.json`, accounting snapshot
and nonce checks. Import only the version-3 plan after reviewing its addresses,
constructor data and release settings. Keep snapshots and wallet-specific plans
private. Older deployment pages do not support this manifest.

The CLI accepts `BASE_LOG_PAGE_SIZE` (default 2000, validated in the snapshot
reader) and allows up to ten minutes for each read queued by the paced proxy.
A failed preparation is not a signing all-clear and does not produce a fresh plan.

## Signing behavior

- Rabby and Base are required; the selected account must match the imported plan
  and must be an ordinary undelegated EOA.
- Only exact reviewed creation data, five predicted CREATE addresses, zero value,
  reviewed Safe ownership and fixed protocol bindings are accepted.
- Runtime masks and expected getters come from the bundled build, never the
  imported file. The predecessor keeper is fixed in the keeper constructor.
- Each click simulates the next constructor, checks gas funding, account/nonces,
  then requests one wallet approval. No approval/signature request is automatic.
- A successful receipt, another confirmation, exact creation provenance, runtime
  and getter checks are required before proceeding to the next contract.
- An uncertain send blocks retry and persists through reload. Recover it only by
  verifying the exact creation hash. A reverted creation consumes its nonce;
  stop and regenerate/review the remaining deployment approach.
- A per-account/starting-nonce browser lock prevents duplicate tab submissions.
- Export the five receipt hashes after verification. Activation is a separate
  freshly simulated Safe batch, requiring nonzero authorized V3 staking supply.

Host all `v3-deployment` assets together over HTTPS only after publication approval.
The bundle is self-contained; there are no executable CDN imports. CSP permits
only same-origin resources. Keep the old pages unchanged and use the distinct
`/v3-deployment/` path.

## Validation

`npm run test:v3-page` runs 6 plan/session tests and 2 real-browser tests.
Install Playwright Chromium for browser tests, or set `STAKED_TEST_CHROME` to an
available Chromium executable. Tests cover altered plans, fixed creation bytes,
exactly five explicit mock approvals, uncertain-send recovery, and CSP loading.
The existing deployment/TWAP page suite also passed all 16 tests after adding the
opt-in five-contract session limit; its default remains four.
