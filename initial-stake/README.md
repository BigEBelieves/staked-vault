# Fixed initial V3 stake page

Deployment helper for exactly 100,000 STAKED on Base; two separate Rabby approvals.
It accepts any connected Rabby account with enough tokens and no existing V3 stake.
The user selects the intended account in Rabby. No personal balance or account is embedded.

The V3 vault/token addresses and exact runtime hashes are pinned in config.json.
Every action rechecks chain, account, code, Safe ownership, balance and current stake.
Allowance must equal the amount before staking; excess approvals are replaced with
this exact amount. Calls are simulated and gas estimated before asking the wallet.
Existing stakes are blocked so this helper cannot reset an existing lock.

An uncertain wallet send is persisted before the request and blocks repeat sends.
Recovery requires the exact sender, destination, data, value and nonce, successful
receipt and another block. The helper checks resulting allowance and stake.
Browser Web Locks serialize signing requests across same-origin tabs.
After a transaction, click Check progress to verify its receipt. Keep the same origin
and browser storage until both receipts are confirmed. Do not clear storage to bypass
recovery. A recovery hash can be obtained from Rabby activity.

This is a desktop Rabby injected-provider helper, not a public staking dapp or
mobile WalletConnect implementation. It does not move existing stakes, configure
contracts, change fee rights, or activate automation. A new stake locks for seven
days; early withdrawal burns 20% of the amount and forfeits all pending rewards.

Build: npm ci --ignore-scripts; node scripts/build-initial-stake.mjs
Test: node --test test/initial-stake-browser.test.mjs
Playwright Chromium or STAKED_TEST_CHROME is required. Tests use synthetic wallets,
not live transactions. Fixture contains public deployed code only.

Publish only index.html, app.bundle.js, style.css and the prepared security headers.
Never upload operational notes, private snapshots, plans, or recovery archives.
