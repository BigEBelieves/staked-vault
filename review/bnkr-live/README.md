# BNKR adapter: scheduling executed, awaiting activation

Verified deployed address: `0xF495BF917D159942ACC6c926Ab883d5a20cF2A05`.
Deployment transaction: https://basescan.org/tx/0x05f53d042c5c29363ff7d204436635afcfb76300a49abfd992526d572fb4c914
Deployment block: 52011272. Creation sender, nonce 217, zero value and complete input match the prepared transaction.

The runtime matches the compiled artifact and expected immutable values. 25 adapter/wiring/ownership getters passed. Adapter paused; operator and limits zero. Safe threshold 2 with 3 owners; observed Safe nonce 9. Existing staking destination remains the Safe.

Sourcify reports exact creation and runtime matches. Its attempts to additionally verify Etherscan/Blockscout were rate limited; no claim is made about their verification status.

- `deployment-verification.json`: read-only on-chain verification and individual scheduling simulations.
- `sourcify-verification.json`: completed source verification result.
- `safe-schedule.json`: two zero-value Safe calls, scheduling policy and distributor destination only.

Scheduling executed successfully at 2026-10-01 00:00:27 UTC in block 52011740:
https://basescan.org/tx/0x9a7361e0cdc4f3e0e60350ce6949a4690823dd02ff8e08c5e61409f8b6781bda

The Safe ExecutionSuccess event matches Safe transaction hash `0xbbb709e53df883e1e5790b6db0c368258885fff3173f13af8d5e69f9a4103a82`. Both zero-value calls match the prepared batch, and both scheduling events match the intended configuration data. Independent Base RPC reads of both configurationReadyAt values agree with the events.

**Earliest activation: 2026-10-03 00:00:27 UTC / Friday October 2, 8:00:27 PM EDT.** Both schedules expire seven days afterward. See `schedule-execution.json`. Re-check live state and simulate the activation batch when mature; this scheduling batch did not activate policy, redirect fees, transfer BNKR or enable staking automation.

The existing Safe BNKR balance is not included in this batch. Fee-origin reconciliation and an explicit Safe transfer are still required to fund this adapter with previously collected fees. No personal Bankr position is involved.

Reproduce verification before scheduling with:

```
node scripts/verify-bnkr-deployment.mjs 0x05f53d042c5c29363ff7d204436635afcfb76300a49abfd992526d572fb4c914
```

This verifier is deliberately for the unconfigured, unscheduled deployment stage. After scheduling or activation, use the corresponding state checks instead of bypassing its assertions.
