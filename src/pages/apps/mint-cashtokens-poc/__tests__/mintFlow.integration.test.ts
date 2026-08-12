import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MintAppUtxo, MintOutputDraft } from '../types';
import {
  buildBootstrapPreview,
  buildMintPreview,
  validateMintRequest,
} from '../services';

const addOutputMock = vi.fn();
const buildTransactionMock = vi.fn();

vi.mock('../../../../apis/TransactionManager/TransactionManager', () => ({
  default: () => ({
    addOutput: addOutputMock,
    buildTransaction: buildTransactionMock,
    sendTransaction: vi.fn(),
    fetchAndStoreTransactionHistory: vi.fn(),
    fetchAndStoreTransactionHistories: vi.fn(),
    getTxHex: vi.fn(),
  }),
}));

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
  beforeEach(() => {
    addOutputMock.mockReset();
    buildTransactionMock.mockReset();
  });

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
    buildTransactionMock.mockResolvedValue({
      hex: '00aa',
      bytecodeSize: 120,
      finalTransaction: '00aa',
      finalOutputs: [{ recipientAddress: 'bitcoincash:qto', amount: 900n }],
      errorMsg: '',
    });

    const funding = [makeUtxo({ value: 1000 })];
    const preview = await buildBootstrapPreview({
      fundingUtxos: funding,
      toAddress: 'bitcoincash:qto',
      changeAddress: 'bitcoincash:qchange',
    });

    expect(preview.feePaid).toBe(100n);
    expect(preview.built.hex).toBe('00aa');
    expect(buildTransactionMock).toHaveBeenCalledTimes(1);
  });

  it('buildMintPreview retries fee candidates until build succeeds', async () => {
    const genesis = makeUtxo({ tx_hash: 'g1', tx_pos: 0, value: 1000, token: null });
    const fee1 = makeUtxo({ tx_hash: 'f1', tx_pos: 1, value: 100, token: null });
    const fee2 = makeUtxo({ tx_hash: 'f2', tx_pos: 1, value: 200, token: null });
    const draft = makeDraft({ sourceKey: 'g1:0' });

    addOutputMock.mockReturnValue({
      recipientAddress: draft.recipientCashAddr,
      amount: 546n,
      token: { category: 'g1', amount: 1n },
    });

    buildTransactionMock
      .mockResolvedValueOnce({
        hex: '',
        bytecodeSize: 0,
        finalTransaction: '',
        finalOutputs: null,
        errorMsg: 'insufficient fee',
      })
      .mockResolvedValueOnce({
        hex: 'beef',
        bytecodeSize: 250,
        finalTransaction: 'beef',
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

    const result = await buildMintPreview({
      selectedUtxos: [genesis],
      flatUtxos: [genesis, fee1, fee2],
      activeOutputDrafts: [draft],
      changeAddress: 'bitcoincash:qchange',
      sdkAddressBook: [{ address: 'bitcoincash:qrecipient', tokenAddress: 'token:qrecipient' }],
      tokenOutputSats: 546,
    });

    expect(buildTransactionMock).toHaveBeenCalledTimes(2);
    expect(result.built.hex).toBe('beef');
    expect(result.inputsForBuild.length).toBe(3);
    expect(result.feePaid >= 0n).toBe(true);
  });

  it('buildMintPreview throws when no fee candidates are available', async () => {
    const genesis = makeUtxo({ tx_hash: 'g1', tx_pos: 0, token: null });
    const draft = makeDraft({ sourceKey: 'g1:0' });

    buildTransactionMock.mockResolvedValue({
      hex: '',
      bytecodeSize: 0,
      finalTransaction: '',
      finalOutputs: null,
      errorMsg: 'build failed',
    });

    await expect(
      buildMintPreview({
        selectedUtxos: [genesis],
        flatUtxos: [genesis],
        activeOutputDrafts: [draft],
        changeAddress: 'bitcoincash:qchange',
        sdkAddressBook: [],
        tokenOutputSats: 546,
      })
    ).rejects.toThrow(
      'No non-token fee UTXOs available to fund transaction fees.'
    );
  });

  it('buildMintPreview throws when addOutput fails for a draft', async () => {
    const genesis = makeUtxo({ tx_hash: 'g1', tx_pos: 0, token: null });
    const fee = makeUtxo({ tx_hash: 'f1', tx_pos: 1, token: null });
    const draft = makeDraft({ sourceKey: 'g1:0' });

    addOutputMock.mockReturnValue(undefined);

    await expect(
      buildMintPreview({
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

    addOutputMock.mockReturnValue({
      recipientAddress: draft.recipientCashAddr,
      amount: 546n,
      token: { category: 'g1', amount: 1n },
    });
    buildTransactionMock.mockResolvedValue({
      hex: '',
      bytecodeSize: 0,
      finalTransaction: '',
      finalOutputs: null,
      errorMsg: 'build failed',
    });

    await expect(
      buildMintPreview({
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
