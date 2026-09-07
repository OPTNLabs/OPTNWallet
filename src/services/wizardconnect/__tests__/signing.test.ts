import { describe, expect, it, vi } from 'vitest';
import {
  binToHex,
  createVirtualMachineBCH,
  decodeTransaction,
  encodeTransaction,
  hexToBin,
} from '@bitauth/libauth';
import type { SignTransactionRequest } from '@wizardconnect/core';
import { Network } from '../../../state/slices/networkSlice';
import { signWizardConnectTransaction } from '../signing';

vi.mock('../derivation', () => ({
  derivePrivateKeyForPath: async () => {
    const key = new Uint8Array(32);
    key[31] = 1;
    return key;
  },
}));

describe('WizardConnect signing', () => {
  it.each(['native', 'relay hex', 'relay extended', 'relay structured'])(
    'signs %s with all UTXOs and leaves the approval payload unchanged',
    async (format) => {
      const lockingBytecode = hexToBin(
        '76a914751e76e8199196d454941c45d1b3a323f1433bd688ac'
      );
      const sourceOutputs = [
        { lockingBytecode, valueSatoshis: 10000n },
        {
          lockingBytecode,
          valueSatoshis: 20000n,
          token: { category: new Uint8Array(32).fill(3), amount: 5n },
        },
      ];
      const unsigned = {
        version: 2,
        locktime: 0,
        inputs: [1, 2].map((value) => ({
          outpointTransactionHash: new Uint8Array(32).fill(value),
          outpointIndex: 0,
          sequenceNumber: 0xffffffff,
          unlockingBytecode: new Uint8Array(),
        })),
        outputs: [{ ...sourceOutputs[1], valueSatoshis: 29000n }],
      };
      const request = {
        transaction: { transaction: unsigned, sourceOutputs },
        inputPaths: [
          [0, 'receive', 0],
          [1, 'change', 0],
        ],
      } as unknown as SignTransactionRequest;
      const originalHex = binToHex(encodeTransaction(unsigned));
      const relayRequest =
        format === 'native'
          ? request
          : JSON.parse(
              JSON.stringify(
                {
                  ...request,
                  transaction: {
                    ...request.transaction,
                    transaction:
                      format === 'relay structured' ? unsigned : originalHex,
                  },
                },
                (_key, value) =>
                  value instanceof Uint8Array
                    ? format === 'relay extended'
                      ? `<Uint8Array: 0x${binToHex(value)}>`
                      : binToHex(value)
                    : typeof value === 'bigint'
                      ? `<bigint: ${value}n>`
                      : value
              )
            );
      const signed = await signWizardConnectTransaction(relayRequest, {
        mnemonic: 'mocked test key',
        passphrase: '',
        network: Network.CHIPNET,
      });
      const transaction = decodeTransaction(hexToBin(signed));
      if (typeof transaction === 'string') throw new Error(transaction);
      expect(
        transaction.inputs.map((input) => input.unlockingBytecode[65])
      ).toEqual([0x61, 0x61]);
      expect(
        createVirtualMachineBCH().verify({ transaction, sourceOutputs })
      ).toBe(true);
      const substituted = sourceOutputs.map((output, index) =>
        index === 1 ? { ...output, valueSatoshis: 20001n } : output
      );
      expect(
        createVirtualMachineBCH().verify({
          transaction,
          sourceOutputs: substituted,
        })
      ).not.toBe(true);
      expect(binToHex(encodeTransaction(unsigned))).toBe(originalHex);
      const withPresetInput = {
        ...request,
        transaction: { ...request.transaction, transaction },
        inputPaths: [[1, 'change', 0]],
      } as SignTransactionRequest;
      expect(
        await signWizardConnectTransaction(withPresetInput, {
          mnemonic: 'mocked test key',
          passphrase: '',
          network: Network.CHIPNET,
        })
      ).toBe(signed);

      for (const invalid of [
        { valueSatoshis: '<bigint: nonsense>' },
        { valueSatoshis: -1n },
        { valueSatoshis: Number.MAX_SAFE_INTEGER + 1 },
        { lockingBytecode: 'zz' },
      ]) {
        const malformed = {
          ...request,
          transaction: {
            ...request.transaction,
            sourceOutputs: [
              { ...sourceOutputs[0], ...invalid },
              sourceOutputs[1],
            ],
          },
        } as unknown as SignTransactionRequest;
        await expect(
          signWizardConnectTransaction(malformed, {
            mnemonic: 'mocked test key',
            passphrase: '',
            network: Network.CHIPNET,
          })
        ).rejects.toThrow(/WizardConnect:/);
      }
    }
  );
});
