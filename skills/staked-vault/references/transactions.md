# Contract scope and transaction rules

Base mainnet chain ID: 8453.

| Role | Address |
|---|---|
| V3 vault, sole staking spender | `0x6e6c236d5ef18caf835faf2bd495ed48e3f8ccc5` |
| STAKED, 18 decimals | `0x731d4066a8375fc590fcd9dfe8d9e58670cb8ba3` |
| USDC reward, 6 decimals | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` |
| BNKR reward, 18 decimals | `0x22af33fe49fd1fa80c7149773dde5890d3c76f3b` |

`plan.py` checks runtime SHA256 fingerprints, immutable token getters, seven-day lock and 20% early-exit penalty at one pinned block. It verifies the block hash again, and simulates any prepared call at that block. This detects known-code mismatches, not malicious RPC providers or every future state change. Bankr must simulate again immediately before sending. Plans expire 120 seconds after the snapshot timestamp.

| Action | Destination | Function | Requirements |
|---|---|---|---|
| Exact approval | STAKED token | `approve(address,uint256)` | Spender fixed to V3 vault; amount exactly requested deposit |
| Stake | V3 vault | `stake(uint256)` | Exact allowance, sufficient user's liquid STAKED |
| Mature withdrawal | V3 vault | `withdraw(uint256)` | Chain timestamp >= lockEnd; sufficient stake |
| Early withdrawal | V3 vault | `earlyWithdraw(uint256)` | Still locked, explicit penalty acceptance, preview |
| Claim both rewards | V3 vault | `getReward()` | Unlocked; accrued USDC or BNKR |

Every call sends zero ETH; ETH for Base gas is separate. No other destinations or methods are authorized by this skill. A wallet may already have a larger approval: the planner reduces it to the requested amount before staking. Keep approvals and staking sequential, never blindly submit a batch. If the allowance has changed after approval, stop and investigate.

Adding a deposit resets the entire position's unlock to seven days after the new deposit. `withdraw` does not claim rewards; claim separately when requested. Early withdrawal burns 20% of the withdrawn principal and forfeits all pending USDC and BNKR for that account, including rewards on the stake left behind. Do not frame it as a fee-free exit or a proportional reward reduction.

Status is an observation at the displayed block, not a guarantee of current rewards or executable transactions. This skill has no custody or submission capability. Bankr's authenticated tool and user authorization are required for execution. Do not claim this integration is live-tested until an authorized user transaction is confirmed.

## Sandbox transport

Version 1.1 embeds both runtime fingerprints in the Python script. `contracts.json` remains an audit copy; its omission by the installer no longer blocks execution. Python uses its default verified SSL context and honors `SSL_CERT_FILE`. An explicit `STAKED_RPC_TRANSPORT=curl` uses verified HTTPS JSON-RPC POST, disables curlrc loading, follows no redirects and performs no automatic transport fallback. No insecure TLS option exists. Neither an HTTP GET 200 nor working Python `--help` verifies RPC access. A 403 may reflect network policy, authorization or a provider rule; do not assume its cause or bypass it.
