import { describe, expect, it, vi } from 'vitest';

import { Network } from '../../../../state/slices/networkSlice';
import {
  buildCauldronPoolV0LockingBytecode,
  getCauldronSubscriptionService,
} from '../../../../services/cauldron';
import {
  fetchCurrentCauldronPools,
  fetchCurrentQuotedPoolsFromCauldron,
} from '../preflight';

vi.mock('../../../../services/cauldron', async () => ({
  ...(await vi.importActual('../../../../services/cauldron')),
  getCauldronSubscriptionService: vi.fn(),
}));

const mockedGetCauldronSubscriptionService = vi.mocked(
  getCauldronSubscriptionService
);

describe('Cauldron live preflight helpers', () => {
  it('uses the live Cauldron snapshot to resolve exact quoted outpoints', async () => {
    const withdrawPublicKeyHash = new Uint8Array(20);
    const tokenId = 'ab'.repeat(32);
    const txHash = 'cd'.repeat(32);
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash },
      txHash,
      outputIndex: 1,
      poolId: null,
      ownerAddress: null,
      ownerPublicKeyHash: null,
      output: {
        amountSatoshis: 1000n,
        tokenCategory: tokenId,
        tokenAmount: 500n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash,
        }),
      },
    };
    const unsubscribe = vi.fn(async () => undefined);
    const subscribe = vi.fn(
      async (
        _requestedTokenId: string,
        callback: (rows: Array<Record<string, unknown>>) => void
      ) => {
        callback([
          {
            new_utxo_txid: txHash,
            new_utxo_n: 1,
            new_utxo_hash: 'ef'.repeat(32),
            spent_utxo_hash: '00'.repeat(32),
            is_withdrawn: false,
            sats: 1000,
            token_amount: 500,
            token_id: tokenId,
            pkh: '00'.repeat(20),
          },
        ]);
        return unsubscribe;
      }
    );
    mockedGetCauldronSubscriptionService.mockReturnValue({
      subscribe,
    } as never);

    const currentPools = await fetchCurrentCauldronPools({
      network: Network.MAINNET,
      tokenId,
    });
    const resolved = await fetchCurrentQuotedPoolsFromCauldron({
      network: Network.MAINNET,
      quotedPools: [pool],
    });

    expect(currentPools).toHaveLength(1);
    expect(resolved.missingQuotedPoolCount).toBe(0);
    expect(resolved.resolvedPools[0]?.txHash).toBe(txHash);
    expect(subscribe).toHaveBeenCalledWith(tokenId, expect.any(Function));
    expect(unsubscribe).toHaveBeenCalled();
  });
});
