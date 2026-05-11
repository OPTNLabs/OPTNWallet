import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuantumrootTrackingService from '../QuantumrootTrackingService';
import KeyService from '../KeyService';

vi.mock('../KeyService', () => ({
  default: {
    retrieveQuantumrootVaults: vi.fn(),
  },
}));

describe('QuantumrootTrackingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deduplicates tracked receive and quantum lock addresses', async () => {
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
      {
        wallet_id: 1,
        account_index: 0,
        address_index: 1,
        receive_address: 'recv-a',
        quantum_lock_address: 'lock-b',
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

    await expect(QuantumrootTrackingService.listTrackedAddresses(1)).resolves.toEqual([
      'recv-a',
      'lock-a',
      'lock-b',
    ]);
  });
});
