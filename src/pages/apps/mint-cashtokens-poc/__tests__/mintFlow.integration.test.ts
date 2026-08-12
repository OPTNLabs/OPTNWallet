import { describe, expect, it, vi } from 'vitest';
import type { AddonSDK } from '../../../../services/AddonsSDK';
import type { MintAppUtxo, MintOutputDraft } from '../types';
import {
  buildBootstrapPreview,
  buildMintPreview,
  validateMintRequest,
} from '../services';

const makeUtxo = (patch: Partial<MintAppUtxo> = {}): MintAppUtxo =>
  ({
    tx_hash: 'tx',
    tx_pos: 0,
    value: 1000,
    address: 'bitcoincash:qtest',
    height: 0,
    token: null,
    ...patch,
  }) as MintAppUtxo;

const makeDraft = (patch: Partial<MintOutputDraft> = {}): MintOutputDraft => ({
  id: 'd1',
  recipientCashAddr: 'bitcoincash:qrecipient',
  sourceKey: 'g1:0',
  config: {
    mintType: 'FT',
    ftAmount: '1',
    nftCapability: 'none',
    nftCommitment: '',
  },
  ...patch,
});

describe('mint flow services', () => {
  it('validateMintRequest returns null for valid request', () => {
    const selected = makeUtxo({ tx_hash: 'g1', tx_pos: 0, token: null });
    const draft = makeDraft({ sourceKey: 'g1:0' });

    const result = validateMintRequest({
      walletId: 1,
      selectedRecipientCount: 1,
      changeAddress: 'bitcoincash:qchange',
      selectedUtxos: [selected],
      activeOutputDrafts: [draft],
      selectedRecipientSet: new Set([draft.recipientCashAddr]),
      selectedSourceKeySet: new Set([draft.sourceKey]),
    });

    expect(result).toBeNull();
  });

  it('buildBootstrapPreview computes fee from sdk build result', async () => {
    const sdk = {
      tx: {
        build: vi.fn().mockResolvedValue({
          hex: '00aa',
          bytes: 120,
          finalOutputs: [{ recipientAddress: 'bitcoincash:qto', amount: 900n }],
          errorMsg: '',
        }),
      },
    } as unknown as AddonSDK;

    const funding = [makeUtxo({ value: 1000 })];
    const preview = await buildBootstrapPreview({
      sdk,
      fundingUtxos: funding,
      toAddress: 'bitcoincash:qto',
      changeAddress: 'bitcoincash:qchange',
    });

    expect(preview.feePaid).toBe(100n);
    expect(preview.built.hex).toBe('00aa');
    expect(sdk.tx.build).toHaveBeenCalledTimes(1);
  });

  it('buildMintPreview retries fee candidates until build succeeds', async () => {
    const genesis = makeUtxo({ tx_hash: 'g1', tx_pos: 0, value: 1000, token: null });
    const fee1 = makeUtxo({ tx_hash: 'f1', tx_pos: 1, value: 100, token: null });
    const fee2 = makeUtxo({ tx_hash: 'f2', tx_pos: 1, value: 200, token: null });
    const draft = makeDraft({ sourceKey: 'g1:0' });

    const addOutput = vi.fn().mockReturnValue({
      recipientAddress: draft.recipientCashAddr,
      amount: 546n,
      token: { category: 'g1', amount: 1n },
    });

    const build = vi
      .fn()
      .mockResolvedValueOnce({
        hex: '',
        bytes: 0,
        finalOutputs: null,
        errorMsg: 'insufficient fee',
      })
      .mockResolvedValueOnce({
        hex: 'beef',
        bytes: 250,
        finalOutputs: [
          {
            recipientAddress: draft.recipientCashAddr,
            amount: 546n,
            token: { category: 'g1', amount: 1n },
          },
          { recipientAddress: 'bitcoincash:qchange', amount: 100n },
        ],
        errorMsg: '',
      });

    const sdk = {
      tx: { addOutput, build },
    } as unknown as AddonSDK;

    const result = await buildMintPreview({
      sdk,
      selectedUtxos: [genesis],
      flatUtxos: [genesis, fee1, fee2],
      activeOutputDrafts: [draft],
      changeAddress: 'bitcoincash:qchange',
      sdkAddressBook: [{ address: 'bitcoincash:qrecipient', tokenAddress: 'token:qrecipient' }],
      tokenOutputSats: 546,
    });

    expect(build).toHaveBeenCalledTimes(2);
    expect(result.built.hex).toBe('beef');
    expect(result.inputsForBuild.length).toBe(3);
    expect(result.feePaid >= 0n).toBe(true);
  });

  it('buildMintPreview throws when no fee candidates are available', async () => {
    const genesis = makeUtxo({ tx_hash: 'g1', tx_pos: 0, token: null });
    const draft = makeDraft({ sourceKey: 'g1:0' });

    const sdk = {
      tx: {
        addOutput: vi.fn(),
        build: vi.fn(),
      },
    } as unknown as AddonSDK;

    await expect(
      buildMintPreview({
        sdk,
        selectedUtxos: [genesis],
        flatUtxos: [genesis],
        activeOutputDrafts: [draft],
        changeAddress: 'bitcoincash:qchange',
        sdkAddressBook: [],
        tokenOutputSats: 546,
      })
    ).rejects.toThrow('No non-genesis UTXOs available to fund transaction fees.');
  });

  it('buildMintPreview throws when addOutput fails for a draft', async () => {
    const genesis = makeUtxo({ tx_hash: 'g1', tx_pos: 0, token: null });
    const fee = makeUtxo({ tx_hash: 'f1', tx_pos: 1, token: null });
    const draft = makeDraft({ sourceKey: 'g1:0' });

    const sdk = {
      tx: {
        addOutput: vi.fn().mockReturnValue(undefined),
        build: vi.fn(),
      },
    } as unknown as AddonSDK;

    await expect(
      buildMintPreview({
        sdk,
        selectedUtxos: [genesis],
        flatUtxos: [genesis, fee],
        activeOutputDrafts: [draft],
        changeAddress: 'bitcoincash:qchange',
        sdkAddressBook: [],
        tokenOutputSats: 546,
      })
    ).rejects.toThrow('Failed creating output');
  });

  it('buildMintPreview throws when every build attempt fails', async () => {
    const genesis = makeUtxo({ tx_hash: 'g1', tx_pos: 0, token: null });
    const fee = makeUtxo({ tx_hash: 'f1', tx_pos: 1, token: null });
    const draft = makeDraft({ sourceKey: 'g1:0' });

    const sdk = {
      tx: {
        addOutput: vi.fn().mockReturnValue({
          recipientAddress: draft.recipientCashAddr,
          amount: 546n,
          token: { category: 'g1', amount: 1n },
        }),
        build: vi.fn().mockResolvedValue({
          hex: '',
          bytes: 0,
          finalOutputs: null,
          errorMsg: 'build failed',
        }),
      },
    } as unknown as AddonSDK;

    await expect(
      buildMintPreview({
        sdk,
        selectedUtxos: [genesis],
        flatUtxos: [genesis, fee],
        activeOutputDrafts: [draft],
        changeAddress: 'bitcoincash:qchange',
        sdkAddressBook: [],
        tokenOutputSats: 546,
      })
    ).rejects.toThrow('Failed to build mint transaction.');
  });
});
