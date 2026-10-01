// Only remove pairing/proposals belonging to this attempt, never unrelated wallets.
export async function closePairing(wc, topic) {
  if (!wc) return;
  const client = wc.signer?.client;
  if (topic && client) {
    for (const proposal of client.proposal.getAll()) {
      if (proposal.pairingTopic === topic) client.core.expirer.set(proposal.id, 0);
    }
    if (client.core.pairing.getPairings().some(p => p.topic === topic))
      await client.core.pairing.disconnect({topic});
  }
  if (wc.session) await wc.disconnect();
}

// A cancelled task retains the slot until it settles and its cleanup succeeds.
export function connectionGate() {
  let active = null;
  return {
    get busy() { return !!active; },
    begin() {
      if (active) return null;
      const attempt = {cancelled:false}; active = attempt; return attempt;
    },
    cancel() { if (active) active.cancelled = true; return active; },
    finish(attempt) { if (active === attempt) active = null; },
  };
}
