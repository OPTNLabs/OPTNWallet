import { describe, expect, it } from 'vitest';

import type { QuantumrootVaultRecord, UTXO } from '../../types/types';
import {
  isConfiguredQuantumrootTokenCategory,
  summarizeQuantumrootTokenAwareness,
} from '../QuantumrootTokenAwarenessService';

function makeVault(category: string): QuantumrootVaultRecord {
  return {
    wallet_id: 1,
    account_index: 0,
    address_index: 0,
    receive_address: 'bchtest:recv',
    quantum_lock_address: 'bchtest:lock',
    receive_locking_bytecode: '',
    quantum_lock_locking_bytecode: '',
    quantum_public_key: '',
    quantum_key_identifier: '',
    vault_token_category: category,
    online_quantum_signer: 0,
    created_at: '2026-04-12T00:00:00.000Z',
    updated_at: '2026-04-12T00:00:00.000Z',
  };
}

function makeTokenUtxo(
  address: string,
  amount: number,
  category: string,
  txPos: number,
  nft = false
): UTXO {
  return {
    address,
    value: 546,
    amount: 546,
    height: 0,
    tx_hash: `tx-${txPos}`,
    tx_pos: txPos,
    token: nft
      ? {
          category,
          amount,
          nft: {
            capability: 'none',
            commitment: '',
          },
        }
      : {
          category,
          amount,
        },
  };
}

describe('QuantumrootTokenAwarenessService', () => {
  it('treats the placeholder category as unconfigured', () => {
    expect(isConfiguredQuantumrootTokenCategory('00'.repeat(32))).toBe(false);
  });

  it('reports token-authorized spend readiness when matching control and receive tokens exist', () => {
    const category = '11'.repeat(32);
    const summary = summarizeQuantumrootTokenAwareness(
      makeVault(category),
      [
        makeTokenUtxo('bchtest:recv', 0, category, 0, true),
        makeTokenUtxo('bchtest:recv', 1, category, 1),
        makeTokenUtxo('bchtest:recv', 2, '33'.repeat(32), 0, true),
      ],
      [
        makeTokenUtxo('bchtest:lock', 0, category, 0, true),
        makeTokenUtxo('bchtest:lock', 1, category, 1),
        makeTokenUtxo('bchtest:lock', 2, '22'.repeat(32), 0, true),
      ]
    );

    expect(summary.hasConfiguredTokenCategory).toBe(true);
    expect(summary.matchingControlTokenUtxos).toHaveLength(1);
    expect(summary.matchingReceiveTokenUtxos).toHaveLength(1);
    expect(summary.unrelatedQuantumLockTokenUtxos).toHaveLength(1);
    expect(summary.canAuthorizedSpend).toBe(true);
    expect(summary.readinessLabel).toBe('Ready to spend');
  });

  it('waits for a tokenized receive UTXO before enabling authorized spend', () => {
    const category = '11'.repeat(32);
    const summary = summarizeQuantumrootTokenAwareness(
      makeVault(category),
      [makeTokenUtxo('bchtest:recv', 0, '33'.repeat(32), 0, true)],
      [makeTokenUtxo('bchtest:lock', 0, category, 0, true)]
    );

    expect(summary.matchingControlTokenUtxos).toHaveLength(1);
    expect(summary.matchingReceiveTokenUtxos).toHaveLength(0);
    expect(summary.canAuthorizedSpend).toBe(false);
    expect(summary.readinessLabel).toBe('Waiting for the matching receive coin');
  });

  it('reports a provisional vault when token category is not configured', () => {
    const summary = summarizeQuantumrootTokenAwareness(
      makeVault('00'.repeat(32)),
      [makeTokenUtxo('bchtest:recv', 0, '33'.repeat(32), 0, true)],
      []
    );

    expect(summary.hasConfiguredTokenCategory).toBe(false);
    expect(summary.matchingControlTokenUtxos).toHaveLength(0);
    expect(summary.tokenizedReceiveUtxos).toHaveLength(1);
    expect(summary.canAuthorizedSpend).toBe(false);
    expect(summary.readinessLabel).toBe('Choose an approval key');
  });
});
