import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apis/ChaingraphManager/ChaingraphManager', () => ({
  queryAuthHead: vi.fn(),
  queryTransactionByHash: vi.fn(),
  stripChaingraphHexBytes: (value: unknown) =>
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/^\\x/i, '')
      .replace(/^0x/i, ''),
}));

import {
  findBcmrOutput,
  parseBcmrOutput,
  resolveAuthChain,
} from '../bcmr/authchain';
import {
  queryAuthHead,
  queryTransactionByHash,
} from '../../apis/ChaingraphManager/ChaingraphManager';

describe('bcmrAuthchainHelpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses a BCMR OP_RETURN output with hash and URIs', () => {
    const parsed = parseBcmrOutput(
      '6a0442434d52201af0d0c37fc4176d667dc033e0994c6dfe0a1fdf8c172b259b2f4364434b1ea335697066733a2f2f516d535855374858774c37746e4c6d6f714a337144545550586b59756e4a7659546648776659634a466f636f6b43'
    );

    expect(parsed.hash).toBe(
      '1af0d0c37fc4176d667dc033e0994c6dfe0a1fdf8c172b259b2f4364434b1ea3'
    );
    expect(parsed.uris).toEqual([
      'ipfs://QmSXU7HXwL7tnLmoqJ3qDTUPXkYunJvYTfHwfYcJFocokC',
    ]);
  });

  it('finds a BCMR output in the transaction outputs', () => {
    expect(
      findBcmrOutput({
        outputs: [
          { locking_bytecode: '76a91400' },
          { locking_bytecode: '6a0442434d5220abcd' },
        ],
      })
    ).toEqual({ locking_bytecode: '6a0442434d5220abcd' });
  });

  it('walks the authchain from the authhead to parents', async () => {
    vi.mocked(queryAuthHead).mockResolvedValue({
      data: {
        transaction: [
          {
            authchains: [
              {
                authhead: {
                  identity_output: [{ transaction_hash: 'headtx' }],
                },
              },
            ],
          },
        ],
      },
    });

    vi.mocked(queryTransactionByHash).mockImplementation(async (txid: string) => {
      if (txid === 'headtx') {
        return {
          data: {
            transaction: [
              {
                hash: 'headtx',
                inputs: [
                  { outpoint_transaction_hash: 'parent', outpoint_index: '0' },
                ],
                outputs: [{ locking_bytecode: '76a91400' }],
              },
            ],
          },
        };
      }

      return {
        data: {
          transaction: [
            {
              hash: 'parent',
              inputs: [],
              outputs: [
                {
                  locking_bytecode:
                    '6a0442434d52201af0d0c37fc4176d667dc033e0994c6dfe0a1fdf8c172b259b2f4364434b1ea3',
                },
              ],
            },
          ],
        },
      };
    });

    const chain = await resolveAuthChain(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );

    expect(queryAuthHead).toHaveBeenCalledWith(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    expect(chain).toHaveLength(2);
    expect(chain[0]?.hash).toBe('headtx');
    expect(chain[1]?.hash).toBe('parent');
  });
});
