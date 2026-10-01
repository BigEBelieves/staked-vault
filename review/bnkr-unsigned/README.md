# Unsigned preparation: do not sign these files yet

These files document the proposal prepared at Base block 52010382 for Rabby nonce
217. The live creation simulation succeeded and returned the expected compiled
runtime and immutable values. No contract was deployed and no Safe batch was sent.

| File | Purpose |
| --- | --- |
| `proposal.json` | Complete read-only deployment and activation proposal |
| `rabby-creation.json` | Raw zero-value CREATE request; review data, not a Rabby import format |
| `safe-schedule-review.json` | Two Safe calls scheduling policy and fee destination |
| `safe-activation-review.json` | Four Safe calls for use only after both delays mature |
| `preparation-evidence.json` | Snapshot, nonce, predicted address and creation simulation hashes |

The deployer is `0xa741dAd09fFF5de643283142eD339b9F0b52b146`; the predicted adapter
is `0xF495BF917D159942ACC6c926Ab883d5a20cF2A05`.
This address is a prediction, not a verified live deployment.

First complete review of the contract revision and proposed policy. After actual
Rabby deployment, verify the receipt, runtime and every immutable/configuration
getter. Only then regenerate/revalidate and simulate the scheduling batch from Safe
`0xb9066550918fa778a4039120eac878230cf8f6FC` before importing it in Safe's Transaction
Builder. Calling an undeployed address does not schedule anything.

The 48-hour wait begins when each scheduling call executes on-chain. Read both
`configurationReadyAt` values and wait for the later one; each schedule expires
seven days after its ready time. The activation batch must be checked and simulated
again after maturity. It cannot be considered ready simply because this JSON exists.

Any nonce, code, ownership, routing, policy or relevant state change requires a fresh
check. If the deployment address changes, regenerate every file and the signing page.
These preparations neither allocate personal assets nor move existing Safe BNKR.
