import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuantumrootPortfolioService from '../QuantumrootPortfolioService';
import KeyService from '../KeyService';
import UTXOService from '../UTXOService';

vi.mock('../KeyService', () => ({
  default: {
    retrieveQuantumrootVaults: vi.fn(),
  },
}));

vi.mock('../UTXOService', () => ({
  default: {
    fetchAndStoreUTXOsMany: vi.fn(),
  },
}));

describe('QuantumrootPortfolioService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('summarizes wallet Quantumroot balances across receive and quantum lock addresses', async () => {
    vi.mocked(KeyService.retrieveQuantumrootVaults).mockResolvedValue([
      {
        wallet_id: 1,
        account_index: 0,
        address_index: 0,
        receive_address: 'recv-a',
        quantum_lock_address: 'lock-a',
        receive_locking_bytecode: '',
        quantum_lock_locking_bytecode: '',
        quantum_public_key: '',
        quantum_key_identifier: '',
        vault_token_category: '',
        online_quantum_signer: 0,
        created_at: '',
        updated_at: '',
      },
    ]);
    vi.mocked(UTXOService.fetchAndStoreUTXOsMany).mockResolvedValue({
      'recv-a': [
        {
          address: 'recv-a',
          value: 1200,
          amount: 1200,
          height: 0,
          tx_hash: 'aa',
          tx_pos: 0,
        },
      ],
      'lock-a': [
        {
          address: 'lock-a',
          value: 800,
          amount: 800,
          height: 0,
          tx_hash: 'bb',
          tx_pos: 0,
        },
      ],
    });

    await expect(QuantumrootPortfolioService.summarizeWallet(1)).resolves.toEqual({
      quantumrootBalanceSats: 2000,
      vaultCount: 1,
    });
  });

  it('returns zero when the wallet has no derived Quantumroot vaults', async () => {
    vi.mocked(KeyService.retrieveQuantumrootVaults).mockResolvedValue([]);

    await expect(QuantumrootPortfolioService.summarizeWallet(1)).resolves.toEqual({
      quantumrootBalanceSats: 0,
      vaultCount: 0,
    });
    expect(UTXOService.fetchAndStoreUTXOsMany).not.toHaveBeenCalled();
  });
});
