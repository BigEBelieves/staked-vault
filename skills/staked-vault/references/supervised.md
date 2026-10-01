# Supervised terminal execution, revision 1.2

## Explicit tradeoff

This mode relies on a present user and a single conversation handling one wallet workflow. It is not concurrency-safe infrastructure. Persistent user files overwrite; they are an audit trail, not atomic locks. There is no documented raw-submit idempotency key or recoverable pre-broadcast ID. Do not call this exactly-once execution. Do not schedule it, expose it as an unattended bot, or let parallel agents execute it.

Before a wallet's first supervised write, explain this limitation and ask the user to confirm that no other transaction requests for that wallet are active in Bankr chats/apps or other signing interfaces. Continue only with that acknowledgement and concrete transaction authorization. A later continuation must recheck the journal and user supervision. Treat an abandoned or uncertain workflow as unresolved, not as expired permission to retry.

## Journal and single-attempt procedure

Use Bankr's persistent user file tools, not temporary sandbox files, under `/staked-vault-operations/base/<lowercase-wallet>/`. A supplied account must match the authenticated wallet. Keep a `current.json` record plus a uniquely named record for each step. Read existing records before writing; never replace an unresolved entry with a different operation or erase it. Evidence-preserving updates to the same operation (including status transitions and recovered hashes) are allowed. Discovery/read failure means stop. A successful list showing no prior records permits first-time initialization after the user supervision acknowledgement; a read error is not evidence that a record is absent. Within the same uninterrupted conversation, its own PREPARED record may proceed through the steps below; records belonging to another or interrupted workflow must be reconciled first. Ignore only records explicitly marked TEST_ONLY_NO_TRANSACTION in the separate test namespace.

Record revision, random request identifier, authenticated wallet, chain, action, exact decimal amount, complete transaction, user authorization, timestamps, baseline balances/allowance/stake/rewards, status, and any returned hash or operation ID. Secret keys and credential-bearing RPC URLs never belong in records. A random request identifier is a local audit label, NOT a Bankr idempotency key.

1. Resolve previous operations using receipts and execution evidence. Stop if any is unresolved. Inspect available activity; check latest/pending nonce via `eth_getTransactionCount`. A mismatch blocks. Equality is only one signal and cannot exclude pending EIP-7702/bundler activity.
2. Generate a pinned planner result, display the exact transaction and consequences, and obtain authorization for that step. Recheck sender and regenerate if stale. Never infer dollar amounts, fees, or transaction authorization.
3. Persist PREPARED in both current and unique records, read both back, and compare exact contents. Any failure stops before submission. This read-back is NOT atomic exclusion.
4. Simulate exact `from`, `to`, `data`, `value` using `eth_call` at `latest`, after verifying Base chain ID. Require simulation success, plan not expired, same sender, and unchanged authorization. Record simulation time and require it to be at most 30 seconds old at the tool invocation; repeat the read-only simulation if journal writes exceed that interval. For approve, require an ABI true result for this known token. If an approval has already been mined for this workflow, a fresh plan must be a stake with exactly matching allowance, not another approval.
5. Persist SUBMITTING in both records and verify read-back BEFORE calling a submission tool. Recheck expiry immediately after record writes. If expired, record NOT_SENT (only if the submission tool has never been invoked), restart steps 2–5 including both journal records and all read-backs. Renew user confirmation if the concrete transaction or its consequences change. Do not treat an interrupted SUBMITTING record as NOT_SENT.
6. Invoke the existing supported Bankr raw-calldata submission tool exactly once. Preserve the planner's chain/to/data/value and authenticated sender; adapt only tool schema types such as chain name or zero-value representation. Do not pass the whole planner result, invent nonce/gas overrides, use a swap endpoint, bypass restrictions, or call a different submission tool as fallback. Use confirmation waiting if the tool actually supports it.
7. If a hash is returned, immediately record SUBMITTED with that hash, then reconcile. A hash is not confirmation. A timeout, error after invocation, malformed response, absent hash, unexpected sender/chain, or failed journal persistence means UNKNOWN. Stop all subsequent on-chain submissions (read-only recovery and evidence-preserving journal updates remain allowed) even if recording UNKNOWN itself fails; the earlier SUBMITTING record remains a stop marker. Report uncertainty to the user. Never automatically retry.

## Receipt and effect checks

Read `eth_getTransactionReceipt`, `eth_getTransactionByHash`, and the canonical block by number through verified HTTPS. Require matching hash, canonical block hash, Base, success status and exact authorized execution. A missing receipt is pending/unknown, not failure. A reverted receipt is a failed step: record it and stop, with no automatic replacement or reauthorization assumption.

For a direct call, verify sender, destination, calldata and value. For a bundled smart-account transaction, the outer sender or destination can differ: require supported decoding/trace or authenticated execution evidence proving the user's account executed the exact call successfully, plus contract events and state changes. Outer receipt success alone can conceal an inner-call failure. If the available tools cannot establish this, stop and mark NEEDS_REVIEW; do not invent the inner execution or proceed to the deposit.

Check allowance after approval; it must equal the requested deposit amount. Check the vault's Staked event/account/amount and stake delta after staking, with no unexplained intervening activity. Check withdrawal/reward events and recipient effects after a withdrawal or claim. Use contract ABI/source to interpret logs; do not guess event signatures. A balance change without the matching execution is not enough.

Persist VERIFIED with evidence in both records and read back before moving to any later step. If this fails, stop. An approval workflow and deposit workflow are separate single-attempt steps, each with its own authorization and record. Keep historical records after completion.

## Recovery rules

A known hash permits read-only receipt polling and reconciliation. A lost hash does NOT permit rebroadcast. Use activity/explorer/chain evidence or Bankr support to identify and verify the exact original execution. Matching nonces, elapsed time, a zero allowance, or no recent activity do not prove nothing was submitted. If it cannot be established, leave the workflow blocked. A new conversation must not erase the stop marker. Reinstalling a skill must not reset journals.

## Sources and scope

https://docs.bankr.bot/wallet-api/submit/ documents raw submission and returned hashes; no idempotency guarantee is documented. https://docs.bankr.bot/x402-cloud/examples/ documents overwriting appKV records without create-if-absent. The Bankr terminal tool surface was reported by the user through Bankr; do not assume every Wallet API option is exposed there.

This revision authorizes no live test by installation alone. Begin with a no-send rehearsal, then request an exact small amount and explicit step approval if the user wants a live test. No personal assets, existing stakes, treasury, fee automations or protocol roles are changed by installing this skill.
