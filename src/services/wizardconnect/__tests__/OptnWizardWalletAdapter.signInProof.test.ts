import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  binToHex,
  createVirtualMachineBCH,
  encodeTransaction,
  secp256k1,
} from '@bitauth/libauth';
import type { SignTransactionRequest } from '@wizardconnect/core';
import {
  BS_GOLDEN,
  buildChallengeTx,
  verifyChallengeTx,
} from './fixtures/badgerSurvivorsChallenge';

// Throwaway test key 0x00..07 stands in for every derived key.
const testKey = () => {
  const key = new Uint8Array(32);
  key[31] = 7;
  return key;
};

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

function bsRequest(): SignTransactionRequest {
  const built = buildChallengeTx(BS_GOLDEN.nonce, BS_GOLDEN.address)!;
  return {
    transaction: {
      transaction: binToHex(
        encodeTransaction({
          version: 2,
          locktime: 0,
          inputs: built.inputs,
          outputs: built.outputs,
        })
      ),
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

  it('signs a proof in software that the Badger Survivors verifier accepts', async () => {
    const adapter = await OptnWizardWalletAdapter.create(1);
    const { signedTransaction } = await adapter.signTransaction(bsRequest());
    expect(
      verifyChallengeTx(createVirtualMachineBCH(), {
        signedTransaction: signedTransaction as string,
        nonce: BS_GOLDEN.nonce,
        address: BS_GOLDEN.address,
      })
    ).toEqual({ ok: true });
    expect(mocks.getElectrumAdapter).not.toHaveBeenCalled();
  });

  it.each(['ledger', 'trezor', 'onekey', 'keystone'])(
    'refuses with a %s connected, before any Electrum fetch or device call',
    async (type) => {
      mocks.state = { hardwareWallet: { type, connected: true } };
      const adapter = await OptnWizardWalletAdapter.create(1);
      await expect(adapter.signTransaction(bsRequest())).rejects.toThrow(
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
    await expect(adapter.signTransaction(bsRequest())).rejects.toThrow(
      /turned off/
    );
  });

  it('refuses a tampered proof on the Ledger path without fetching anything', async () => {
    mocks.state = { hardwareWallet: { type: 'ledger', connected: true } };
    const request = bsRequest();
    const built = buildChallengeTx(BS_GOLDEN.nonce, BS_GOLDEN.address)!;
    built.outputs[1] = { ...built.outputs[1], valueSatoshis: 1n };
    (request.transaction as { transaction: string }).transaction = binToHex(
      encodeTransaction({
        version: 2,
        locktime: 0,
        inputs: built.inputs,
        outputs: built.outputs,
      })
    );
    const adapter = await OptnWizardWalletAdapter.create(1);
    await expect(adapter.signTransaction(request)).rejects.toThrow(
      /sign-in proof refused/
    );
    expect(mocks.getElectrumAdapter).not.toHaveBeenCalled();
    expect(mocks.signWithLedger).not.toHaveBeenCalled();
  });
});
