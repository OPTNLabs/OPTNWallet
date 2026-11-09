import { describe, expect, it } from 'vitest';
import { cashAddressToLockingBytecode, hexToBin } from '@bitauth/libauth';
import type { ConnectorTransactionPreview } from '../transactionPreview';
import { deriveConnectorWalletEffect } from '../connectorWalletEffect';

const WALLET_ADDRESS = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
const CATEGORY = 'ab'.repeat(32);

function lock(address = WALLET_ADDRESS): Uint8Array {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  return decoded.bytecode;
}

function preview(): ConnectorTransactionPreview {
  return {
    inputs: [
      {
        outpointTransactionHash: new Uint8Array(32),
        outpointIndex: 0,
        valueSatoshis: 10_000n,
        lockingBytecode: lock(),
        token: {
          category: hexToBin(CATEGORY),
          amount: 10n,
          nft: { capability: 'mutable', commitment: new Uint8Array([1]) },
        },
      },
      {
        outpointTransactionHash: new Uint8Array(32),
        outpointIndex: 1,
        valueSatoshis: 50_000n,
        lockingBytecode: new Uint8Array([0x51]),
      },
    ],
    outputs: [
      {
        valueSatoshis: 4_000n,
        lockingBytecode: lock(),
        token: { category: hexToBin(CATEGORY), amount: 6n },
      },
      { valueSatoshis: 55_000n, lockingBytecode: new Uint8Array([0x51]) },
    ],
    totalInput: 60_000n,
    totalOutput: 59_000n,
    fee: 1_000n,
  };
}

describe('connector wallet effect', () => {
  it('separates wallet-owned inputs and change from whole-transaction totals', () => {
    expect(deriveConnectorWalletEffect(preview(), [WALLET_ADDRESS])).toEqual({
      ownedInputCount: 1,
      ownedOutputCount: 1,
      bchDeltaSats: -6_000n,
      tokenEffects: [{ category: CATEGORY, fungibleDelta: -4n, nftDelta: -1 }],
    });
  });

  it('does not infer ownership when no locking bytecode matches', () => {
    expect(deriveConnectorWalletEffect(preview(), [])).toEqual({
      ownedInputCount: 0,
      ownedOutputCount: 0,
      bchDeltaSats: 0n,
      tokenEffects: [],
    });
  });
});
