const SYNTHETIC_SOURCE_TXID = '11'.repeat(32);

export function assertChipnetNetwork(network) {
  if (network !== 'chipnet') {
    throw new Error('Connector Lab is Chipnet-only; refusing a non-Chipnet request.');
  }
}
export function assertBroadcastPolicy({ network, request, broadcastEnabled, livePreflight }) {
  assertChipnetNetwork(network);
  if (!request.broadcast) return;
  if (broadcastEnabled !== true) {
    throw new Error('Broadcast is disabled; set the explicit lab broadcast gate first.');
  }
  if (livePreflight !== true) {
    throw new Error('Broadcast requires a successful live Chipnet UTXO preflight.');
  }
  if (request.transaction.inputs.some((input) => input.outpointTransactionHash === SYNTHETIC_SOURCE_TXID)) {
    throw new Error('Broadcast refused: the request still uses the synthetic lab outpoint.');
  }
}
export function assertDisjointFundingBatches(batches) {
  const seen = new Set();
  for (const batch of batches) {
    for (const input of batch) {
      const key = `${input.txid}:${input.outpointIndex}`;
      if (seen.has(key)) throw new Error(`Funding batch overlap: ${key}`);
      seen.add(key);
    }
  }
  return true;
}
export function allocateDisjointBchBatches(utxos, connectors, minimumSatoshis = 1000000n) {
  if (!Array.isArray(connectors) || connectors.length === 0) {
    throw new Error('At least one connector is required for funding allocation.');
  }
  const candidates = utxos.filter(
    (utxo) => !utxo.token && BigInt(utxo.valueSatoshis) >= minimumSatoshis
  );
  if (candidates.length < connectors.length) {
    throw new Error(
      `Insufficient BCH-only UTXOs for ${connectors.length} disjoint connector batches.`
    );
  }
  const batches = connectors.map((connector, index) => ({
    connector,
    inputs: [candidates[index]],
  }));
  assertDisjointFundingBatches(batches.map((batch) => batch.inputs));
  return batches;
}

export function buildTokenPreservationPlan(utxos, feeSatoshis = 250n) {
  return utxos.filter((utxo) => utxo.token).map((utxo) => {
    const value = BigInt(utxo.valueSatoshis);
    if (value <= feeSatoshis) {
      throw new Error(`Token UTXO ${utxo.txid.slice(0, 8)} cannot cover the preservation fee.`);
    }
    return {
      input: {
        txid: utxo.txid,
        outpointIndex: utxo.outpointIndex,
        valueSatoshis: value.toString(),
        token: utxo.token,
      },
      output: {
        valueSatoshis: (value - feeSatoshis).toString(),
        token: { ...utxo.token },
        destination: 'wallet-derived-chipnet-receive-address',
      },
    };
  });
}

export function assertTokenPreservation(plan) {
  for (const item of plan) {
    if (item.input.token.category !== item.output.token.category) {
      throw new Error('Token category changed during preservation planning.');
    }
    if (item.input.token.amount !== item.output.token.amount) {
      throw new Error('Token amount changed during preservation planning.');
    }
    if ((item.input.token.nftCapability ?? null) !== (item.output.token.nftCapability ?? null)) {
      throw new Error('NFT capability changed during preservation planning.');
    }
    if ((item.input.token.nftCommitment ?? null) !== (item.output.token.nftCommitment ?? null)) {
      throw new Error('NFT commitment changed during preservation planning.');
    }
  }
  return true;
}
