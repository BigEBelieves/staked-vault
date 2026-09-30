# BNKR staking adapter: Rabby deployment package

Prepared for review, not published as a live signing site. No transaction was sent.
Contract source is pinned to `d16ecaedab1149971f834fcb21623ed03f1fc0bd`.

This package uses the existing deployment engine for one direct CREATE on Base.
It deploys a paused adapter with zero operator and zero limits, controlled by the
existing Safe. It does not import Safe batches, approve tokens, transfer funds,
configure the adapter or change the live automation.

- Deployer: `0xa741dAd09fFF5de643283142eD339b9F0b52b146`
- Prepared nonce: 217
- Predicted address: `0xF495BF917D159942ACC6c926Ab883d5a20cF2A05`
- Constructor value: 0 ETH; the deployer pays gas.

The prepared address depends on the nonce. If the wallet sends another transaction,
regenerate the entire proposal, page and Safe batch references. Do not manually
edit the address or bypass a nonce mismatch.

## After review

Serve this directory over HTTPS at a separate deployment URL. Do not replace the
public staking website. The page is intended for Rabby's browser extension on a
laptop; mobile layout testing does not establish mobile wallet compatibility.

Connect the displayed account, select Base, and click the single deployment button.
The page simulates creation, estimates gas and checks account/nonces before asking
Rabby for approval. Check the creation details in Rabby. It then verifies the exact
transaction, receipt, runtime and immutable/configuration getters after confirmation.
Download the receipt and verify the deployment before any Safe scheduling.

An ambiguous submission error blocks retries until the exact transaction is recovered.
Never clear browser storage to bypass an uncertain submission.

## Rebuild and checks

```
npm run compile
node scripts/prepare-bnkr-staking.mjs DEPLOYER CURRENT_NONCE
node scripts/build-bnkr-deployment-page.mjs build/bnkr-staking-proposal.json REVIEWED_CONTRACT_SHA
node --test test/bnkr-deployment-page.test.mjs
npx playwright install chromium
node --test test/bnkr-deployment-browser.test.mjs
```

Review `../review/BNKR-STAKING-REVIEW.md` and `../review/bnkr-unsigned/README.md`.
Future activation must use fresh state and the actual on-chain ready times.
