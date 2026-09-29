# Rabby deployment page

This page requests four separate **direct CREATE** transactions from the prepared Rabby account
on Base. Each transaction has zero ETH value, sends the exact compiled creation bytecode, and
assigns helper authority to the Safe. It does not create Safe proposals, alter existing vault
settings, move fee rights, approve tokens, enable an operator, or start automations.

This page permits inactive deployment before independent review. That review is still
outstanding. This is not an audited release. Solidity code cannot be edited after deployment;
code fixes may require replacements and new Safe wiring. Losses may be unrecoverable. Activating
the live protocol is a separate decision after deployed-source and configuration verification.

## Signing

1. Open the page on the laptop in the browser with the Rabby extension.
2. Connect the displayed deployment account and select Base.
3. Click **Deploy reward relay**, review the contract creation and gas in Rabby, and approve.
4. Wait for a successful, verified receipt. Repeat for guard, executor and collector in order.
5. Download the receipts and verify all four live deployments with the repository tooling.

Every creation is simulated before requesting a signature. The page checks the returned runtime,
gas budget, current wallet/chain/nonces and known previous receipts. After confirmation it checks
the exact creation transaction, address, canonical receipt, runtime code and public constructor
settings. The guard must remain paused, with no operator, executor, references or budget.

No wallet request is opened on page load or during inspection. A browser lock prevents two tabs
from opening concurrent requests. The page waits for the receipt's block plus one additional
block; this is a short confirmation check, not finality. Re-read production state before migration.

Explicit wallet rejection can be retried. Unknown submission errors leave a persistent stop marker;
recover the confirmed transaction hash from Rabby/BaseScan before continuing. Do not clear storage
or send another transaction to bypass an uncertain submission. If the wallet nonce changes, a
creation fails, or a transaction is replaced, review and regenerate the remaining deployment plan.

The download contains an object with a `hashes` array in deployment order. Supply that array to
the existing deployment verifier. A download with null entries is an incomplete deployment.

## Build and tests

```sh
npm run compile
node scripts/build-deployment-page.mjs /absolute/path/deployment-plan.json SOURCE_COMMIT
node --test test/deployment-page.test.mjs
```

The generator validates the plan against the current compiler artifacts and Base configuration,
then embeds expected getter results and compiler-designated immutable slots. The payload's SHA-256
is pinned in a separate module so mixed/stale publication files fail closed. This checksum does
not protect against compromise of the website or repository itself. No external script/CDN is used.

Sources:
- https://rabby.io/docs/integrating-rabby-wallet
- https://ethereum.org/developers/docs/apis/json-rpc/
- https://docs.base.org/specifications/transactions/network-fees
