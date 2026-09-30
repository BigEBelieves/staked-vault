# BNKR adapter: live deployment, awaiting scheduling

Verified deployed address: `0xF495BF917D159942ACC6c926Ab883d5a20cF2A05`.
Deployment transaction: https://basescan.org/tx/0x05f53d042c5c29363ff7d204436635afcfb76300a49abfd992526d572fb4c914
Deployment block: 52011272. Creation sender, nonce 217, zero value and complete input match the prepared transaction.

The runtime matches the compiled artifact and expected immutable values. 25 adapter/wiring/ownership getters passed. Adapter paused; operator and limits zero. Safe threshold 2 with 3 owners; observed Safe nonce 9. Existing staking destination remains the Safe.

Sourcify reports exact creation and runtime matches. Its attempts to additionally verify Etherscan/Blockscout were rate limited; no claim is made about their verification status.

- `deployment-verification.json`: read-only on-chain verification and individual scheduling simulations.
- `sourcify-verification.json`: completed source verification result.
- `safe-schedule.json`: two zero-value Safe calls, scheduling policy and distributor destination only.

No scheduling transaction has been executed. Both configuration ready times were zero at the recorded snapshot. The 48-hour clock has NOT started. Import the scheduling file in Safe Transaction Builder, simulate the complete batch, obtain the required signatures and execute. Then verify both on-chain ready times and record the execution hash. Signing or queueing alone does not start the clock.

The existing Safe BNKR balance is not included in this batch. Fee-origin reconciliation and an explicit Safe transfer are still required to fund this adapter with previously collected fees. No personal Bankr position is involved.

Reproduce verification before scheduling with:

```
node scripts/verify-bnkr-deployment.mjs 0x05f53d042c5c29363ff7d204436635afcfb76300a49abfd992526d572fb4c914
```

This verifier is deliberately for the unconfigured, unscheduled deployment stage. After scheduling or activation, use the corresponding state checks instead of bypassing its assertions.
