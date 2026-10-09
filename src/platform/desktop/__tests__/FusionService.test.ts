import { beforeEach, describe, expect, it, vi } from 'vitest';

const keys = vi.hoisted(() => ({
  retrieveKeys: vi.fn(),
  fetchAddressPrivateKey: vi.fn(),
}));
vi.mock('../../../services/KeyService', () => ({ default: keys }));

import { gatherInputs } from '../FusionService';
import type { UTXO } from '../../../types/types';

const address = 'bchtest:qqs3eeafad6hv2d8g7tzc9xhl5p72xtzjcfyv70a96';
const coin = (extra: Partial<UTXO> = {}): UTXO =>
  ({
    address,
    tx_hash: 'aa'.repeat(32),
    tx_pos: 1,
    value: 50_000,
    height: 1,
    ...extra,
  }) as UTXO;

describe('gatherInputs', () => {
  beforeEach(() => {
    keys.retrieveKeys.mockResolvedValue([
      { address, publicKey: new Uint8Array(33).fill(2) },
    ]);
    keys.fetchAddressPrivateKey.mockResolvedValue(new Uint8Array(32).fill(1));
  });

  it('signs plain coins', async () => {
    const [input] = await gatherInputs(1, [coin()]);
    expect(input).toMatchObject({
      prev_txid: 'aa'.repeat(32),
      prev_index: 1,
      value: 50_000,
    });
  });

  it('refuses a token coin before any key is fetched', async () => {
    const category = 'bb'.repeat(32);
    for (const extra of [
      { token: { category, amount: 1 } },
      { token_data: { category, amount: '1' } },
    ] as Partial<UTXO>[]) {
      keys.fetchAddressPrivateKey.mockClear();
      await expect(gatherInputs(1, [coin(extra)])).rejects.toThrow(
        'Token coins cannot be fused'
      );
      expect(keys.fetchAddressPrivateKey).not.toHaveBeenCalled();
    }
  });
});
