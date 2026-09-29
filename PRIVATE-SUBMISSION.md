# Base submission findings — 2026-09-29

**A Base submission path is documented; an end-to-end private Bankr integration is not verified.**
No provider account was created, paid service ordered, credential requested, or live transaction sent.

| Primary source | Verified documentation | Deployment consequence |
|---|---|---|
| [bloXroute Base Transactions](https://docs.bloxroute.com/base/submit-transactions/base-transactions) | Cloud API `blxr_tx`, `blockchain_network: "Base-Mainnet"`, raw transaction bytes without `0x`, authenticated HTTPS/WSS; automatic Backrunning enrollment is documented. | Candidate submission API. Its disclosure and fallback policy need confirmation for the actual service tier. |
| [bloXroute Base Speed Boost](https://docs.bloxroute.com/base/submit-transactions/speed-boost) | Describes a private connection to the sequencer and a purchasable routing service. | A private transport connection alone does not establish transaction confidentiality across every participant. |
| [Flashbots Protect quick start](https://docs.flashbots.net/flashbots-protect/quick-start) | Lists Ethereum mainnet (chain 1) and Sepolia. | Do not configure the Ethereum Protect URL as a Base endpoint. |
| [Base transaction ordering](https://docs.base.org/specifications/transactions/transaction-ordering) | Ordering depends on fee and arrival time across Flashblocks. | Neither a quote nor fast routing guarantees the execution block or price. |
| [Chainstack MEV protection](https://docs.chainstack.com/docs/mev-protection) | Lists Base mainnet and an add-on that routes `eth_sendRawTransaction` to a partner network. Removing the add-on restores public routing. | Candidate for a standard JSON-RPC integration. Verify add-on status and the actual account's failure/disclosure policy; the endpoint URL alone cannot prove protection. |
| [Bankr sign endpoint](https://docs.bankr.bot/wallet-api/sign/) | Documents `eth_signTransaction` without broadcasting. Requires a write-enabled Wallet API key. Keys configured with allowed recipients block this signing method. | Verify the exact wallet's returned format and signer. Do not remove recipient restrictions to get around a signing rejection. A personal-message signature does not prove raw-transaction support. |

The old bloXroute search result titled “Private Transactions” redirects to a removed page.
The current Base submission page above is the source for the method and parameters. We have not
established that every `blxr_tx` Base submission has the same confidentiality as Speed Boost.

## Information required from the chosen provider/integration

Record these answers and the provider's dated documentation before enabling swaps:

- Exact Base service/endpoint and entitlement; chain ID 8453; required submission method.
- Who sees raw transactions, including Backrunning participants; whether full calldata is shared
  before ordering; whether that sharing can be disabled for this service.
- Explicit no-public-fallback behavior on errors, congestion, delayed inclusion and retries.
- Expiry, replacement/cancellation and duplicate-submission behavior; a returned hash is not inclusion.
- Whether Bankr can return a signed transaction **without broadcasting it elsewhere**, or submit
  through this exact provider path. For its EIP-7702/ZeroDev wallet, establish whether signing yields
  a raw transaction or a user operation and which bundler sees it. `blxr_tx` expects a raw transaction;
  support for ordinary raw transactions does not prove support for this wallet flow.

Do not paste API keys into GitHub, Safe notes or chat. Provider support questions can be sent by the
account owner; no message has been sent on their behalf as part of this work.

## Sender requirements

The repository intentionally has no sender. An integration must preserve the planner's destination,
calldata, zero ETH value, chain, nonce and short deadline, check the head again after signing, use
only the reviewed provider method, and stop when delivery is uncertain. Do not change to a public
endpoint as a retry. Observe transaction status before preparing a conflicting replacement.

`revalidateKeeper` now checks the unsigned plan against fresh on-chain state and simulates it again.
It does not sign, send, validate raw signed bytes or attest to provider privacy. A future sender must
also decode the signed transaction, recover the signer, compare every execution field with the
approved plan, and reject unsupported user-operation or delegation-changing envelopes.

Before choosing a service, establish both sides of the integration: Bankr's sign-only output for
the actual wallet, and a provider route accepting that exact format with no public fallback.
No account has been connected or service selected by these documentation findings.

The guard independently limits prices and spending. Its current policy references are Safe-reviewed
ratios, not a TWAP feed. Privacy does not replace these limits, prevent predictable-timing attacks,
or guarantee a successful swap. Collection without swapping can be assessed separately.
