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

function makeTokenUtxo(address: string, category: string, txPos: number): UTXO {
  return {
    address,
    value: 546,
    amount: 546,
    height: 0,
    tx_hash: `tx-${txPos}`,
    tx_pos: txPos,
    token: {
      category,
      amount: 1,
    },
  };
}

describe('QuantumrootTokenAwarenessService', () => {
  it('treats the placeholder category as unconfigured', () => {
    expect(isConfiguredQuantumrootTokenCategory('00'.repeat(32))).toBe(false);
  });

  it('reports token-authorized spend readiness when a matching control token exists', () => {
    const category = '11'.repeat(32);
    const summary = summarizeQuantumrootTokenAwareness(
      makeVault(category),
      [],
      [
        makeTokenUtxo('bchtest:lock', category, 0),
        makeTokenUtxo('bchtest:lock', '22'.repeat(32), 1),
      ]
    );

    expect(summary.hasConfiguredTokenCategory).toBe(true);
    expect(summary.matchingControlTokenUtxos).toHaveLength(1);
    expect(summary.unrelatedQuantumLockTokenUtxos).toHaveLength(1);
    expect(summary.canAuthorizedSpend).toBe(true);
    expect(summary.readinessLabel).toBe('Ready for token-authorized spend');
  });

  it('reports a provisional vault when token category is not configured', () => {
    const summary = summarizeQuantumrootTokenAwareness(
      makeVault('00'.repeat(32)),
      [makeTokenUtxo('bchtest:recv', '33'.repeat(32), 0)],
      []
    );

    expect(summary.hasConfiguredTokenCategory).toBe(false);
    expect(summary.matchingControlTokenUtxos).toHaveLength(0);
    expect(summary.tokenizedReceiveUtxos).toHaveLength(1);
    expect(summary.canAuthorizedSpend).toBe(false);
    expect(summary.readinessLabel).toBe('Control token category not configured');
  });
});
