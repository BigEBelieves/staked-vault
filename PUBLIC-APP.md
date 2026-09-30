# V3 public staking app — release candidate

This branch changes the website only. No contract deployment or migration is part of publishing it.

## Build and preview

Use Node 22 or later, `npm ci`, then `npm run build:web`.
Serve the repository root over localhost for development or HTTPS in production.
`npm run test:web` builds and runs mocked-wallet Chromium tests; first install the test browser with `npx playwright install --with-deps chromium`.
The optional STAKED_TEST_CHROME environment variable selects an installed Chromium binary.

Cloudflare static upload contents: `index.html`, `_headers`, `legacy/index.html`, and the complete `assets/vault/` directory. Preserve paths. Do not upload the repository, deployment plans, node_modules, private snapshots, or signing tools.
The build bundles executable dependencies locally, adds CSP and entry-point SRI, and includes third-party license notices.

## Routing

- `/`: V3 vault 0x6E6c236D5EF18cAF835fAf2bD495ED48e3F8CCc5. New stakes, mature withdrawals, explicit early withdrawals and reward claims.
- `/legacy/`: V2 vault 0x01b568eBCFb8c6db2Cf1c5f70c9b105f4187D92F. Claims and withdrawals only in this UI. This does not disable deposits at the contract level.
- There is no automatic transfer of existing positions. Every new deposit starts/resets the whole position's seven-day lock.
- Early withdrawal retains the contract's 20% penalty and ALL pending reward forfeiture, even on a partial withdrawal. The UI previews and confirms these consequences.
- Fee conversion is threshold-dependent. BNKR automatic staking and automated buybacks are not enabled by the current automation.

## Wallet safeguards

Exact-amount approvals; separate approval and stake clicks; simulations before sends; Base/account checks; Web Locks to serialize each account's requests across tabs; persistent unresolved-request records before wallet submission.
After a timeout/reload, the user must verify a mined transaction (or mined replacement at the same sender nonce) before another send. Unknown/unbroadcast requests are deliberately not cleared automatically. If no transaction was ever submitted, support must investigate wallet state before a manual recovery; do not advise a blind retry or clearing site data.
No private keys are entered into this site. Legacy and V3 share the pending-request guard per account.

## Remaining release checks

- Restrict the existing Reown/WalletConnect project to the intended Cloudflare origin and later the custom domain. The project ID is public; account ownership and its allowlist have NOT been verified here.
- Test real iOS and Android wallet handoffs (same-phone browser and wallet app, returning to the page, rejection, reconnect and wrong chain). Test desktop Rabby and QR-to-phone connection. No real-money wallet actions were performed by the automated tests.
- Check Safari and Firefox in addition to the automated Chromium checks.
- Verify Cloudflare serves `/legacy/`, all lazy chunks, CSP headers and licenses; inspect browser console and wallet connection. Do not redirect missing assets to the app HTML.
- Inspect the published contract links, correct account balances, and the old/new vault selection before signing any test transaction. No further stake is authorized by generating this website.
- Live BNKR conversion and the first scheduled automation run remain separate operational checks. A zero queue does not test conversion.
- Protect GitHub branches with required checks; enable account 2FA. These account settings are not changed by this branch.

The tests are regression checks, not an independent security audit. Hold broad public promotion until the real-device checks pass.
