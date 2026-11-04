import { describe, expect, it } from 'vitest';
import {
  assertBroadcastPolicy,
  assertChipnetNetwork,
  assertDisjointFundingBatches,
  allocateDisjointBchBatches,
  assertTokenPreservation,
  buildTokenPreservationPlan,
} from '../connector-lab/safety.mjs';

const request = (txid = '22'.repeat(32), broadcast = false) => ({
  broadcast,
  transaction: {
    inputs: [{ outpointTransactionHash: txid, outpointIndex: 0 }],
  },
});
describe('connector lab safety gates', () => {
  it('allows non-broadcast review requests on Chipnet', () => {
    expect(() => assertBroadcastPolicy({
      network: 'chipnet',
      request: request(),
      broadcastEnabled: false,
      livePreflight: false,
    })).not.toThrow();
  });

  it('refuses broadcast without live preflight or with the synthetic outpoint', () => {
    expect(() => assertBroadcastPolicy({
      network: 'chipnet',
      request: request('22'.repeat(32), true),
      broadcastEnabled: true,
      livePreflight: false,
    })).toThrow(/live Chipnet UTXO preflight/);

    expect(() => assertBroadcastPolicy({
      network: 'chipnet',
      request: request('11'.repeat(32), true),
      broadcastEnabled: true,
      livePreflight: true,
    })).toThrow(/synthetic lab outpoint/);
  });

  it('rejects non-Chipnet and overlapping connector funding batches', () => {
    expect(() => assertChipnetNetwork('mainnet')).toThrow(/Chipnet-only/);
    expect(() => assertDisjointFundingBatches([
      [{ txid: 'a', outpointIndex: 0 }],
      [{ txid: 'a', outpointIndex: 0 }],
    ])).toThrow(/Funding batch overlap/);
  });

  it('allocates only BCH-only UTXOs into disjoint connector batches', () => {
    const batches = allocateDisjointBchBatches([
      { txid: 'token', outpointIndex: 0, valueSatoshis: '9000000', token: { category: 'aa' } },
      { txid: 'b', outpointIndex: 0, valueSatoshis: '1000000', token: null },
      { txid: 'c', outpointIndex: 1, valueSatoshis: '2000000', token: null },
      { txid: 'd', outpointIndex: 2, valueSatoshis: '3000000', token: null },
    ], ['walletconnect', 'wizardconnect', 'cashconnect']);
    expect(batches.map((batch) => batch.inputs[0].txid)).toEqual(['b', 'c', 'd']);
  });

  it('preserves token identity while reserving only a BCH fee', () => {
    const plan = buildTokenPreservationPlan([{
      txid: 'token',
      outpointIndex: 0,
      valueSatoshis: '1000000',
      token: {
        category: 'aa',
        amount: '42',
        nftCapability: 'mutable',
        nftCommitment: 'beef',
      },
    }]);
    expect(plan[0].output.valueSatoshis).toBe('999750');
    expect(plan[0].output.token).toEqual(plan[0].input.token);
    expect(assertTokenPreservation(plan)).toBe(true);
  });
});
