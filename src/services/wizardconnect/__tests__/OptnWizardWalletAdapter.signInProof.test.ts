import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  binToHex,
  createVirtualMachineBCH,
  decodeTransaction,
  encodeTransaction,
  hexToBin,
  secp256k1,
} from '@bitauth/libauth';
import type { SignTransactionRequest } from '@wizardconnect/core';
import {
  buildCanonicalSignInProof,
  p2pkhLockingBytecode,
} from '../signInProof';

// Throwaway test key 0x00..07 stands in for every derived key.
const testKey = () => {
  const key = new Uint8Array(32);
  key[31] = 7;
  return key;
};

const TEST_CODE = 'Session_abcdef-0123456789';

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  electrumRequest: vi.fn(),
  getElectrumAdapter: vi.fn(),
  signWithLedger: vi.fn(),
  signWithTrezor: vi.fn(),
  signWithOneKey: vi.fn(),
}));

vi.mock('../../../apis/WalletManager/WalletManager', () => ({
  default: () => ({
    getWalletInfo: async () => ({
      mnemonic: 'mocked test key',
      passphrase: '',
      networkType: 'mainnet',
      wallet_name: 'Test',
      derivation_path: "m/44'/145'/0'",
    }),
  }),
}));
vi.mock('../../KeyService', () => ({
  default: {
    getWalletXpubs: async () => ({
      receive: 'xpub-r',
      change: 'xpub-c',
      defi: 'xpub-d',
    }),
  },
}));
vi.mock('../derivation', () => ({
  derivePublicKeyFromXpub: () => secp256k1.derivePublicKeyCompressed(testKey()),
  derivePrivateKeyForPath: async () => testKey(),
}));
vi.mock('../relayKeyStore', () => ({
  hydrateRelayKeys: async () => undefined,
  getOrCreateRuntimeRelayKey: () => new Uint8Array(32),
}));
vi.mock('../../RpaService', () => ({ deriveRpaGateXpub: vi.fn() }));
vi.mock('../../../state/store', () => ({
  store: { getState: () => mocks.state },
}));
vi.mock('../../hardware/hardwareWalletSigning', () => ({
  signWithLedger: mocks.signWithLedger,
  signWithTrezor: mocks.signWithTrezor,
  signWithOneKey: mocks.signWithOneKey,
}));
vi.mock('../../ElectrumAdapter', () => ({
  default: mocks.getElectrumAdapter,
}));

import { OptnWizardWalletAdapter } from '../OptnWizardWalletAdapter';

function proofRequest(): SignTransactionRequest {
  const publicKey = secp256k1.derivePublicKeyCompressed(
    testKey()
  ) as Uint8Array;
  const built = buildCanonicalSignInProof(
    TEST_CODE,
    p2pkhLockingBytecode(publicKey)
  );
  return {
    transaction: {
      transaction: binToHex(encodeTransaction(built.transaction)),
      sourceOutputs: built.sourceOutputs,
      broadcast: false,
    },
    sequence: 1,
    inputPaths: [[0, 'receive', 0]],
  } as unknown as SignTransactionRequest;
}

describe('OptnWizardWalletAdapter sign-in proofs', () => {
  beforeEach(() => {
    mocks.state = {};
    mocks.getElectrumAdapter.mockReset();
    mocks.getElectrumAdapter.mockReturnValue({
      request: mocks.electrumRequest,
    });
    mocks.electrumRequest.mockReset();
    mocks.signWithLedger.mockReset();
    mocks.signWithTrezor.mockReset();
    mocks.signWithOneKey.mockReset();
  });

  it('signs a WCPROOF in software that the BCH VM accepts', async () => {
    const adapter = await OptnWizardWalletAdapter.create(1);
    const request = proofRequest();
    const { signedTransaction } = await adapter.signTransaction(request);
    const signed = decodeTransaction(hexToBin(signedTransaction as string));
    if (typeof signed === 'string') throw new Error(signed);
    const publicKey = secp256k1.derivePublicKeyCompressed(
      testKey()
    ) as Uint8Array;
    const { sourceOutputs } = buildCanonicalSignInProof(
      TEST_CODE,
      p2pkhLockingBytecode(publicKey)
    );
    expect(
      createVirtualMachineBCH().verify({
        transaction: signed,
        sourceOutputs,
      })
    ).toBe(true);
    expect(mocks.getElectrumAdapter).not.toHaveBeenCalled();
  });

  it.each(['ledger', 'trezor', 'onekey', 'keystone'])(
    'refuses with a %s connected, before any Electrum fetch or device call',
    async (type) => {
      mocks.state = { hardwareWallet: { type, connected: true } };
      const adapter = await OptnWizardWalletAdapter.create(1);
      await expect(adapter.signTransaction(proofRequest())).rejects.toThrow(
        /not supported with a .* hardware wallet/
      );
      expect(mocks.getElectrumAdapter).not.toHaveBeenCalled();
      expect(mocks.electrumRequest).not.toHaveBeenCalled();
      expect(mocks.signWithLedger).not.toHaveBeenCalled();
      expect(mocks.signWithTrezor).not.toHaveBeenCalled();
      expect(mocks.signWithOneKey).not.toHaveBeenCalled();
    }
  );

  it('refuses when sign-in proofs are turned off', async () => {
    mocks.state = { preferences: { enableWizardSignInProofs: false } };
    const adapter = await OptnWizardWalletAdapter.create(1);
    await expect(adapter.signTransaction(proofRequest())).rejects.toThrow(
      /turned off/
    );
  });

  it('refuses a tampered proof on the Ledger path without fetching anything', async () => {
    mocks.state = { hardwareWallet: { type: 'ledger', connected: true } };
    const request = proofRequest();
    const publicKey = secp256k1.derivePublicKeyCompressed(
      testKey()
    ) as Uint8Array;
    const built = buildCanonicalSignInProof(
      TEST_CODE,
      p2pkhLockingBytecode(publicKey)
    );
    built.transaction.outputs[1] = {
      ...built.transaction.outputs[1],
      valueSatoshis: 1n,
    };
    (request.transaction as { transaction: string }).transaction = binToHex(
      encodeTransaction(built.transaction)
    );
    const adapter = await OptnWizardWalletAdapter.create(1);
    await expect(adapter.signTransaction(request)).rejects.toThrow(
      /sign-in proof refused/
    );
    expect(mocks.getElectrumAdapter).not.toHaveBeenCalled();
    expect(mocks.signWithLedger).not.toHaveBeenCalled();
  });
});
