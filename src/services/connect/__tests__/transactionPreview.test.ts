import { describe, expect, it } from 'vitest';
import { transactionPreview } from '../transactionPreview';

function request() {
  const lockingBytecode = new Uint8Array([0x51]);
  return {
    transaction: {
      version: 2,
      locktime: 0,
      inputs: [
        {
          outpointTransactionHash: new Uint8Array(32).fill(3),
          outpointIndex: 4,
          sequenceNumber: 0xffffffff,
          unlockingBytecode: new Uint8Array(),
        },
      ],
      outputs: [{ lockingBytecode, valueSatoshis: 9_000n }],
    },
    sourceOutputs: [{ lockingBytecode, valueSatoshis: 10_000n }],
  };
}

describe('connector transaction preview boundary', () => {
  it('uses input outpoints, not source-output metadata, and computes a nonnegative fee', () => {
    const { transaction, sourceOutputs } = request();
    const preview = transactionPreview(transaction, sourceOutputs);
    expect(preview.inputs[0].outpointIndex).toBe(4);
    expect(preview.inputs[0].outpointTransactionHash).toEqual(
      transaction.inputs[0].outpointTransactionHash
    );
    expect(preview.fee).toBe(1_000n);
  });

  it('rejects missing sources and impossible totals before approval', () => {
    const { transaction, sourceOutputs } = request();
    expect(() => transactionPreview(transaction, [])).toThrow();
    sourceOutputs[0].valueSatoshis = 8_000n;
    expect(() => transactionPreview(transaction, sourceOutputs)).toThrow(
      'invalid totals'
    );
  });

  it('rejects malformed outpoints and values rather than treating them as zero', () => {
    const { transaction, sourceOutputs } = request();
    transaction.inputs[0].outpointTransactionHash = new Uint8Array(31);
    expect(() => transactionPreview(transaction, sourceOutputs)).toThrow(
      'bytecode length'
    );
    transaction.inputs[0].outpointTransactionHash = new Uint8Array(32);
    expect(() =>
      transactionPreview(transaction, [
        { ...sourceOutputs[0], valueSatoshis: 'garbled' },
      ])
    ).toThrow('invalid value');
  });

  it('retains NFT identity and capability for the review', () => {
    const { transaction, sourceOutputs } = request();
    const preview = transactionPreview(
      {
        ...transaction,
        outputs: [
          {
            ...transaction.outputs[0],
            token: {
              category: new Uint8Array(32).fill(2),
              amount: 0n,
              nft: {
                capability: 'minting',
                commitment: new Uint8Array([0xab]),
              },
            },
          },
        ],
      },
      sourceOutputs
    );
    expect(preview.outputs[0].token?.nft).toEqual({
      capability: 'minting',
      commitment: new Uint8Array([0xab]),
    });
  });
});
