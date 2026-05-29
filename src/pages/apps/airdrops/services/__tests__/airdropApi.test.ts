import { describe, expect, it, vi } from 'vitest';
import { createAirdropApi } from '../airdropApi';
import type { AddonSDK } from '../../../../../services/AddonsSDK';

describe('createAirdropApi', () => {
  it('imports token holders through the backend endpoint', async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      recipients: [
        {
          id: 'rcp_1',
          workspace_id: 'workspace_1',
          label: 'Holder 1',
          address: 'bitcoincash:qtestholder',
          source: 'tokenindex',
        },
      ],
    });

    const sdk = {
      http: {
        fetchJson,
      },
    } as unknown as AddonSDK;

    const api = createAirdropApi(sdk, 'https://events.optnlabs.com/');

    const result = await api.importTokenHolders(
      'workspace_1',
      '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22',
      200
    );

    expect(fetchJson).toHaveBeenCalledWith(
      'https://events.optnlabs.com/admin/workspaces/workspace_1/recipients/token-holders',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          category:
            '8d76840bf20eb57f002e67f0ddec0698639db6c99c4a9c736f711b7c86fcbf22',
          limit: 200,
        }),
      })
    );
    expect(result).toEqual([
      {
        id: 'rcp_1',
        workspace_id: 'workspace_1',
        label: 'Holder 1',
        address: 'bitcoincash:qtestholder',
        source: 'tokenindex',
      },
    ]);
  });
});
