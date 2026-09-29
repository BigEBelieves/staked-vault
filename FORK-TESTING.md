# Base integration test

Run this test against an isolated local Anvil fork, not a live wallet or public write endpoint.
The runner starts a read-only upstream proxy and a local Optimism-family Anvil node. All
`eth_sendTransaction`, impersonation and time changes are sent only to that local node.
The upstream proxy has an explicit method allowlist and cannot forward transaction submissions.

## Reproduce

Requirements: Node.js, Python 3, curl and Anvil 1.7.1. Install Anvil from
[Foundry](https://github.com/foundry-rs/foundry) or its official `@foundry-rs/anvil@1.7.1` npm package.

```sh
npm ci
ANVIL_BIN=/absolute/path/to/anvil BASE_READ_RPC_URL=https://mainnet.base.org npm run test:fork
```

The default recorded block is **51,929,714**. Override `BASE_FORK_BLOCK` to retest another block.
The upstream RPC must retain state at the selected block. Contract ownership or beneficiary
changes since the snapshot may legitimately invalidate the initial-state assertions.
Ports 18545 and 18554 are bound to loopback only. The runner closes its child processes at exit.

`npm test` remains the offline regression suite. `npm run test:fork` is opt-in because it needs
network access and historical Base state. It writes its observations to
`test/results/base-fork-<block>.json`. A passing report is evidence for that snapshot and scenario.

## Recorded result

**67 fork checks passed** at Base block **51,929,714** (2026-09-29 02:26:15 UTC), using
Anvil 1.7.1 with the Optimism/Jovian engine. Block hash:
`0x49e5675c2b3d823d6c125762ce8557f14669d76a0f08d85bc118bcad04827ad7`.

The same branch passes all **146 offline checks**. No production contract changes were needed
as a result of this integration run. The helpers were later deployed on Base;
see [DEPLOY.md](DEPLOY.md) for the separate live deployment record.

| Local fork scenario | Observed result |
|---|---|
| Distribution | 1,105.920633091813692258 BNKR -> 0.440606 USDC into the original vault |
| Buyback | 0.051840 USDC -> 275,722.369955309738233584 STAKED burned |
| Tight v4 boundary | Reverted; reserve, guard budget and guard nonce preserved |
| Fee collection | Real newly accrued fees split to burn, Safe and distributor queue |
| Emergency rollback | Safe recovered its 95% fee share; both legacy keepers returned to zero |

These amounts are test fixtures, not recommended production trade sizes or price references.
The [machine-readable result](test/results/base-fork-51929714.json) records raw units and limitations.
All activity above occurred only in the local fork; no live funds were moved.

## What is exercised

- Actual Safe owners, threshold, approvals, `execTransaction` and deployed MultiSendCallOnly.
- Current contract owners, disabled legacy keepers, payout addresses, allowances and fee shares.
- Local deployment of proposed helpers, atomic Safe wiring and preservation of queued BNKR.
- Deployment from generated constructor calldata with receipt, runtime and immutable verification;
  generated Safe wiring, fee-rights and rollback batches; rejection of substituted receipts,
  premature fee-rights transfer and repeated wiring. Offline checks cover corrupted manifests,
  altered runtime code, and compatibility with the previously imported Safe checksum.
- Actual Doppler fee collection, beneficiary transfer, payout splits and beneficiary rollback.
- Actual USDC/STAKED/BNKR contracts, staking, a funded reward stream and early withdrawal.
- Uniswap v3 quotes and swaps through both route directions.
- Uniswap v4 quotes, bounded swaps, Doppler hook settlement and final vault burn.
- A deliberately restrictive v4 boundary that must revert without consuming reserve or guard budget.
- Denied keeper bypasses, replay protection, allowance cleanup and emergency rollback.

## Fixture changes and limits

This uses copied Base state. Only within that copy:

- ETH balances are increased for gas and two existing Safe owners are impersonated to approve hashes.
  No real wallet signs. Hardware-wallet UX and recovery are not tested.
- Existing Bankr-held tokens fund small trial amounts through normal transfers. No staking-program
  position is withdrawn, and no ERC20 balances or protocol storage slots are patched.
- The distributor's minimum batch is lowered through the Safe for a small trial, and a temporary
  BNKR donor is authorized. This is not a recommendation to change production settings.
- Time advances to create early-withdrawal rewards; ordinary local blocks advance two seconds.
- Safe reference policies use local pool quotes solely to test integration. They are not independent
  production price approvals or a validated oracle.

The tests do not prove future liquidity, price-feed independence, RPC privacy, quote latency,
hardware-signature delivery, or security against every attack. An independent contract review,
production configuration review and a small signed deployment trial remain required.

## Primary deployment references

- [Uniswap v3 on Base](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments)
- [Uniswap v4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments)
- [Safe MultiSendCallOnly 1.4.1 deployment](https://github.com/safe-global/safe-deployments/blob/main/src/assets/v1.4.1/multi_send_call_only.json)
- [Safe 1.4.1 implementation](https://github.com/safe-global/safe-smart-account/blob/v1.4.1/contracts/Safe.sol)
