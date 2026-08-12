import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AddonSDK } from '../../../../../services/AddonsSDK';
import type { MintAppUtxo, MintOutputDraft } from '../../types';
import { buildBootstrapPreview, buildMintPreview } from '../mintTransactions';

const { buildTransactionMock } = vi.hoisted(() => ({
  buildTransactionMock: vi.fn(),
}));

vi.mock('../../../../../services/TransactionService', () => ({
  default: {
    buildTransaction: buildTransactionMock,
  },
}));

function makeUtxo(patch: Partial<MintAppUtxo> = {}): MintAppUtxo {
  return {
    address: 'bitcoincash:qsrc',
    height: 0,
    tx_hash: 'a'.repeat(64),
    tx_pos: 0,
    value: 1000,
    token: null,
    ...patch,
  } as MintAppUtxo;
}

function makeDraft(patch: Partial<MintOutputDraft> = {}): MintOutputDraft {
  return {
    id: 'd1',
    recipientCashAddr: 'bitcoincash:qrcp',
    sourceKey: `${'g'.repeat(64)}:0`,
    config: {
      mintType: 'FT',
      ftAmount: '1',
      nftCapability: 'none',
      nftCommitment: '',
    },
    ...patch,
  };
}

describe('mintTransactions', () => {
  beforeEach(() => {
    buildTransactionMock.mockReset();
  });

  it('buildBootstrapPreview throws on build error and missing built fields', async () => {
    buildTransactionMock.mockResolvedValueOnce({
      errorMsg: 'boom',
      finalOutputs: null,
      finalTransaction: '',
      bytecodeSize: 0,
    });

    const sdkError = {
      tx: {
        build: vi.fn().mockResolvedValue({ errorMsg: 'boom', finalOutputs: null, hex: '' }),
      },
    } as unknown as AddonSDK;

    await expect(
      buildBootstrapPreview({
        sdk: sdkError,
        fundingUtxos: [makeUtxo()],
        toAddress: 'bitcoincash:qto',
        changeAddress: 'bitcoincash:qchange',
      })
    ).rejects.toThrow('boom');

    buildTransactionMock.mockResolvedValueOnce({
      errorMsg: '',
      finalOutputs: null,
      finalTransaction: '',
      bytecodeSize: 0,
    });

    const sdkMissing = {
      tx: {
        build: vi.fn().mockResolvedValue({ errorMsg: '', finalOutputs: null, hex: '' }),
      },
    } as unknown as AddonSDK;

    await expect(
      buildBootstrapPreview({
        sdk: sdkMissing,
        fundingUtxos: [makeUtxo()],
        toAddress: 'bitcoincash:qto',
        changeAddress: 'bitcoincash:qchange',
      })
    ).rejects.toThrow('Failed to build bootstrap transaction.');
  });

  it('buildBootstrapPreview computes fee from input-output delta', async () => {
    buildTransactionMock.mockResolvedValueOnce({
      errorMsg: '',
      finalOutputs: [{ recipientAddress: 'bitcoincash:qto', amount: 800n }],
      finalTransaction: 'beef',
      bytecodeSize: 42,
    });

    const sdk = {
      tx: {
        build: vi.fn().mockResolvedValue({
          errorMsg: '',
          hex: 'beef',
          finalOutputs: [{ recipientAddress: 'bitcoincash:qto', amount: 800n }],
        }),
      },
    } as unknown as AddonSDK;

    const out = await buildBootstrapPreview({
      sdk,
      fundingUtxos: [makeUtxo({ value: 1000 })],
      toAddress: 'bitcoincash:qto',
      changeAddress: 'bitcoincash:qchange',
    });

    expect(out.feePaid).toBe(200n);
  });

  it('buildMintPreview errors when no genesis inputs or no successful build', async () => {
    buildTransactionMock.mockResolvedValue({
      errorMsg: 'still failing',
      finalOutputs: null,
      finalTransaction: '',
      bytecodeSize: 0,
    });

    const sdk = {
      tx: { addOutput: vi.fn(), build: vi.fn() },
    } as unknown as AddonSDK;

    await expect(
      buildMintPreview({
        sdk,
        selectedUtxos: [makeUtxo({ tx_pos: 1 })],
        flatUtxos: [makeUtxo({ tx_pos: 1 })],
        activeOutputDrafts: [makeDraft()],
        changeAddress: 'bitcoincash:qchange',
        sdkAddressBook: [],
        tokenOutputSats: 546,
      })
    ).rejects.toThrow('No valid Candidate UTXO selected');

    const genesis = makeUtxo({ tx_hash: 'g'.repeat(64), tx_pos: 0, value: 1000, token: null });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 1, value: 2000, token: null });

    const sdkFail = {
      tx: {
        addOutput: vi.fn().mockReturnValue({ recipientAddress: 'bitcoincash:qrcp', amount: 546n }),
        build: vi.fn().mockResolvedValue({ errorMsg: 'still failing', hex: '', finalOutputs: null }),
      },
    } as unknown as AddonSDK;

    await expect(
      buildMintPreview({
        sdk: sdkFail,
        selectedUtxos: [genesis],
        flatUtxos: [genesis, fee],
        activeOutputDrafts: [makeDraft({ sourceKey: `${genesis.tx_hash}:0` })],
        changeAddress: 'bitcoincash:qchange',
        sdkAddressBook: [],
        tokenOutputSats: 546,
      })
    ).rejects.toThrow('Failed to build mint transaction.');
  });

  it('buildMintPreview passes NFT args and returns fee-paid', async () => {
    buildTransactionMock.mockResolvedValueOnce({
      errorMsg: '',
      finalOutputs: [
        { recipientAddress: 'bitcoincash:qrcp', amount: 546n },
        { recipientAddress: 'bitcoincash:qchange', amount: 6000n },
      ],
      finalTransaction: 'c0de',
      bytecodeSize: 123,
    });

    const genesis = makeUtxo({ tx_hash: 'g'.repeat(64), tx_pos: 0, value: 5000, token: null });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 1, value: 2000, token: null });

    const nftDraft = makeDraft({
      sourceKey: `${genesis.tx_hash}:0`,
      config: {
        mintType: 'NFT',
        ftAmount: '999',
        nftCapability: 'mutable',
        nftCommitment: 'abcd',
      },
    });

    const addOutput = vi.fn().mockReturnValue({
      recipientAddress: 'bitcoincash:qrcp',
      amount: 546n,
      token: { category: genesis.tx_hash, amount: 0n, nft: { capability: 'mutable', commitment: 'abcd' } },
    });

    const build = vi.fn().mockResolvedValue({
      errorMsg: '',
      hex: 'c0de',
      finalOutputs: [
        { recipientAddress: 'bitcoincash:qrcp', amount: 546n },
        { recipientAddress: 'bitcoincash:qchange', amount: 6000n },
      ],
    });

    const sdk = { tx: { addOutput, build } } as unknown as AddonSDK;

    const out = await buildMintPreview({
      sdk,
      selectedUtxos: [genesis],
      flatUtxos: [genesis, fee],
      activeOutputDrafts: [nftDraft],
      changeAddress: 'bitcoincash:qchange',
      sdkAddressBook: [{ address: 'bitcoincash:qrcp', tokenAddress: 'simpleledger:qrcp' }],
      tokenOutputSats: 546,
    });

    expect(addOutput).toHaveBeenCalledWith(
      'bitcoincash:qrcp',
      546,
      0n,
      genesis.tx_hash,
      [genesis, fee],
      [{ address: 'bitcoincash:qrcp', tokenAddress: 'simpleledger:qrcp' }],
      'mutable',
      'abcd'
    );
    expect(out.built.hex).toBe('c0de');
    expect(out.feePaid).toBe(454n);
  });

  it('buildMintPreview keeps a wallet-controlled output before BCMR OP_RETURN when enabled', async () => {
    buildTransactionMock.mockResolvedValueOnce({
      errorMsg: '',
      finalOutputs: [
        { recipientAddress: 'bitcoincash:qchange', amount: 1000n },
        { opReturn: ['BCMR'] },
        { recipientAddress: 'bitcoincash:qrcp', amount: 546n },
      ],
      finalTransaction: 'c0de',
      bytecodeSize: 123,
    });

    const genesis = makeUtxo({ tx_hash: 'g'.repeat(64), tx_pos: 0, value: 5000, token: null });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 1, value: 2000, token: null });
    const draft = makeDraft({ sourceKey: `${genesis.tx_hash}:0` });

    const addOutput = vi.fn().mockReturnValue({
      recipientAddress: 'bitcoincash:qrcp',
      amount: 546n,
      token: { category: genesis.tx_hash, amount: 1n },
    });

    const build = vi.fn().mockResolvedValue({
      errorMsg: '',
      hex: 'c0de',
      finalOutputs: [
        { recipientAddress: 'bitcoincash:qchange', amount: 1000n },
        { opReturn: ['BCMR'] },
        { recipientAddress: 'bitcoincash:qrcp', amount: 546n },
      ],
    });

    const sdk = { tx: { addOutput, build } } as unknown as AddonSDK;

    await buildMintPreview({
      sdk,
      selectedUtxos: [genesis],
      flatUtxos: [genesis, fee],
      activeOutputDrafts: [draft],
      changeAddress: 'bitcoincash:qchange',
      sdkAddressBook: [],
      tokenOutputSats: 546,
      bcmrPublication: {
        enabled: true,
        registryJson: '{"name":"demo"}',
        uris: ['ipfs://bafy123'],
      },
    });

    const firstBuildOutputs = buildTransactionMock.mock.calls[0]?.[0] as Array<{
      recipientAddress?: string;
      amount?: bigint;
      opReturn?: string[];
    }>;
    expect(firstBuildOutputs[0]).toEqual({
      recipientAddress: 'bitcoincash:qchange',
      amount: 1000n,
    });
    expect(firstBuildOutputs[1].opReturn?.[0]).toBe('BCMR');
  });
});
