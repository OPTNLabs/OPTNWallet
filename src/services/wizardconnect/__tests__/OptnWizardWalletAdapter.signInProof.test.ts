import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVirtualMachineBCH,
  decodeTransaction,
  hexToBin,
} from '@bitauth/libauth';
import {
  proofRequest,
  refusalNamed,
  sdkRequest,
  vectors,
} from './signInProofVectors';

// The wallet is the public BIP39 test mnemonic the shared vectors were made
// from, so the adapter derives real keys and must reproduce the vector bytes.
const proof = vectors.proofs[0];

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
      mnemonic: vectors.wallet.mnemonic,
      passphrase: '',
      networkType: 'mainnet',
      wallet_name: 'Test',
      derivation_path: vectors.wallet.accountPath,
    }),
  }),
}));
vi.mock('../../KeyService', () => ({
  default: { getWalletXpubs: async () => vectors.wallet.xpubs },
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

  it('inspects a proof to the address at the requested path', async () => {
    const adapter = await OptnWizardWalletAdapter.create(1);
    expect(adapter.inspectSignInProof(proofRequest(proof))).toMatchObject({
      code: proof.code,
      path: proof.path,
      addressIndex: proof.addressIndex,
      address: proof.addresses.mainnet,
    });
  });

  it('signs a WCPROOF in software that the BCH VM accepts', async () => {
    const adapter = await OptnWizardWalletAdapter.create(1);
    const { signedTransaction } = await adapter.signTransaction(
      proofRequest(proof)
    );
    expect(signedTransaction).toBe(proof.signed);
    const signed = decodeTransaction(hexToBin(signedTransaction as string));
    if (typeof signed === 'string') throw new Error(signed);
    expect(
      createVirtualMachineBCH().verify({
        transaction: signed,
        sourceOutputs: [
          {
            lockingBytecode: hexToBin(proof.lockingBytecode),
            valueSatoshis: BigInt(vectors.format.valueSatoshis),
          },
        ],
      })
    ).toBe(true);
    expect(mocks.getElectrumAdapter).not.toHaveBeenCalled();
  });

  it.each(['ledger', 'trezor', 'onekey', 'keystone'])(
    'refuses with a %s connected, before any Electrum fetch or device call',
    async (type) => {
      mocks.state = { hardwareWallet: { type, connected: true } };
      const adapter = await OptnWizardWalletAdapter.create(1);
      await expect(
        adapter.signTransaction(proofRequest(proof))
      ).rejects.toThrow(/not supported with a .* hardware wallet/);
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
    await expect(adapter.signTransaction(proofRequest(proof))).rejects.toThrow(
      /turned off/
    );
  });

  it('refuses a tampered proof on the Ledger path without fetching anything', async () => {
    mocks.state = { hardwareWallet: { type: 'ledger', connected: true } };
    const tampered = refusalNamed('a tampered output value');
    const adapter = await OptnWizardWalletAdapter.create(1);
    await expect(
      adapter.signTransaction(sdkRequest(tampered.request))
    ).rejects.toThrow(
      `WizardConnect sign-in proof refused: ${tampered.reason}`
    );
    expect(mocks.getElectrumAdapter).not.toHaveBeenCalled();
    expect(mocks.signWithLedger).not.toHaveBeenCalled();
  });
});
