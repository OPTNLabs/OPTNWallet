import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { MintAppUtxo, MintOutputDraft } from '../../types';
import { buildBootstrapPreview, buildMintPreview } from '../mintTransactions';

const mocks = vi.hoisted(() => ({
  addOutput: vi.fn(),
  buildTransaction: vi.fn(),
}));

vi.mock('../../../../../apis/TransactionManager/TransactionManager', () => ({
  default: () => ({
    addOutput: mocks.addOutput,
  }),
}));

vi.mock('../../../../../services/TransactionService', () => ({
  default: {
    buildTransaction: mocks.buildTransaction,
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
    mocks.addOutput.mockReset();
    mocks.buildTransaction.mockReset();
  });

  it('buildBootstrapPreview throws on build error and missing built fields', async () => {
    mocks.buildTransaction.mockResolvedValue({
      errorMsg: 'boom',
      finalOutputs: null,
      finalTransaction: '',
      bytecodeSize: 0,
      hex: '',
    });

    await expect(
      buildBootstrapPreview({
        fundingUtxos: [makeUtxo()],
        toAddress: 'bitcoincash:qto',
        changeAddress: 'bitcoincash:qchange',
      })
    ).rejects.toThrow('boom');

    mocks.buildTransaction.mockResolvedValue({
      errorMsg: '',
      finalOutputs: null,
      finalTransaction: '',
      bytecodeSize: 0,
      hex: '',
    });

    await expect(
      buildBootstrapPreview({
        fundingUtxos: [makeUtxo()],
        toAddress: 'bitcoincash:qto',
        changeAddress: 'bitcoincash:qchange',
      })
    ).rejects.toThrow('Failed to build bootstrap transaction.');
  });

  it('buildBootstrapPreview computes fee from input-output delta', async () => {
    mocks.buildTransaction.mockResolvedValue({
      errorMsg: '',
      hex: 'beef',
      finalTransaction: 'beef',
      bytecodeSize: 1,
      finalOutputs: [{ recipientAddress: 'bitcoincash:qto', amount: 800n }],
    });

    const out = await buildBootstrapPreview({
      fundingUtxos: [makeUtxo({ value: 1000 })],
      toAddress: 'bitcoincash:qto',
      changeAddress: 'bitcoincash:qchange',
    });

    expect(out.feePaid).toBe(200n);
  });

  it('buildMintPreview errors when no genesis inputs or no successful build', async () => {
    await expect(
      buildMintPreview({
        selectedUtxos: [makeUtxo({ tx_pos: 1 })],
        flatUtxos: [makeUtxo({ tx_pos: 1 })],
        activeOutputDrafts: [makeDraft()],
        changeAddress: 'bitcoincash:qchange',
        sdkAddressBook: [],
        tokenOutputSats: 546,
      })
    ).rejects.toThrow(
      'Only genesis UTXOs or minting authority NFTs can be used as mint sources.'
    );

    const genesis = makeUtxo({ tx_hash: 'g'.repeat(64), tx_pos: 0, value: 1000, token: null });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 1, value: 2000, token: null });

    mocks.addOutput.mockReturnValue({ recipientAddress: 'bitcoincash:qrcp', amount: 546n });
    mocks.buildTransaction.mockResolvedValue({
      errorMsg: 'still failing',
      hex: '',
      finalTransaction: '',
      bytecodeSize: 0,
      finalOutputs: null,
    });

    await expect(
      buildMintPreview({
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

    mocks.addOutput.mockReturnValue({
      recipientAddress: 'bitcoincash:qrcp',
      amount: 546n,
      token: { category: genesis.tx_hash, amount: 0n, nft: { capability: 'mutable', commitment: 'abcd' } },
    });

    mocks.buildTransaction.mockResolvedValue({
      errorMsg: '',
      hex: 'c0de',
      finalTransaction: 'c0de',
      bytecodeSize: 1,
      finalOutputs: [
        { recipientAddress: 'bitcoincash:qrcp', amount: 546n },
        { recipientAddress: 'bitcoincash:qchange', amount: 6000n },
      ],
    });

    const out = await buildMintPreview({
      selectedUtxos: [genesis],
      flatUtxos: [genesis, fee],
      activeOutputDrafts: [nftDraft],
      changeAddress: 'bitcoincash:qchange',
      sdkAddressBook: [{ address: 'bitcoincash:qrcp', tokenAddress: 'simpleledger:qrcp' }],
      tokenOutputSats: 546,
    });

    expect(mocks.addOutput).toHaveBeenCalledWith(
      'bitcoincash:qrcp',
      546,
      0n,
      genesis.tx_hash,
      expect.any(Array),
      expect.any(Array),
      'mutable',
      'abcd'
    );
    expect(out.built.hex).toBe('c0de');
    expect(out.feePaid).toBe(454n);
  });

  it('buildMintPreview supports fungible outputs from genesis sources', async () => {
    const genesis = makeUtxo({ tx_hash: 'g'.repeat(64), tx_pos: 0, value: 5000, token: null });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 1, value: 2000, token: null });

    const ftDraft = makeDraft({
      sourceKey: `${genesis.tx_hash}:${genesis.tx_pos}`,
      config: {
        mintType: 'FT',
        ftAmount: '25',
        nftCapability: 'none',
        nftCommitment: '',
      },
    });

    mocks.addOutput.mockReturnValue({
      recipientAddress: 'bitcoincash:qrcp',
      amount: 546n,
      token: { category: genesis.tx_hash, amount: 25n },
    });

    mocks.buildTransaction.mockResolvedValue({
      errorMsg: '',
      hex: 'f00d',
      finalTransaction: 'f00d',
      bytecodeSize: 1,
      finalOutputs: [
        { recipientAddress: 'bitcoincash:qrcp', amount: 546n, token: { category: genesis.tx_hash, amount: 25n } },
        { recipientAddress: 'bitcoincash:qchange', amount: 6000n },
      ],
    });

    const out = await buildMintPreview({
      selectedUtxos: [genesis],
      flatUtxos: [genesis, fee],
      activeOutputDrafts: [ftDraft],
      changeAddress: 'bitcoincash:qchange',
      sdkAddressBook: [],
      tokenOutputSats: 546,
    });

    expect(mocks.addOutput).toHaveBeenCalledWith(
      'bitcoincash:qrcp',
      546,
      25n,
      genesis.tx_hash,
      expect.any(Array),
      expect.any(Array),
      undefined,
      undefined
    );
    expect(out.built.hex).toBe('f00d');
    expect(out.feePaid).toBe(454n);
  });

  it('buildMintPreview supports minting authority NFT sources by category', async () => {
    const category = 'c'.repeat(64);
    const mintingAuthority = makeUtxo({
      tx_hash: 'm'.repeat(64),
      tx_pos: 2,
      value: 6000,
      token: {
        category,
        amount: 0,
        nft: { capability: 'minting', commitment: 'seed' },
      },
    });
    const fee = makeUtxo({
      tx_hash: 'f'.repeat(64),
      tx_pos: 1,
      value: 2000,
      token: null,
    });

    const nftDraft = makeDraft({
      sourceKey: `${mintingAuthority.tx_hash}:${mintingAuthority.tx_pos}`,
      config: {
        mintType: 'NFT',
        ftAmount: '1',
        nftCapability: 'mutable',
        nftCommitment: 'next',
      },
    });

    mocks.addOutput
      .mockReturnValueOnce({
        recipientAddress: 'bitcoincash:qrcp',
        amount: 546n,
        token: {
          category,
          amount: 0n,
          nft: { capability: 'mutable', commitment: 'next' },
        },
      })
      .mockReturnValueOnce({
        recipientAddress: mintingAuthority.address,
        amount: 546n,
        token: {
          category,
          amount: 0n,
          nft: { capability: 'minting', commitment: 'seed' },
        },
      });

    mocks.buildTransaction.mockResolvedValue({
      errorMsg: '',
      hex: 'cafe',
      finalTransaction: 'cafe',
      bytecodeSize: 1,
      finalOutputs: [
        { recipientAddress: 'bitcoincash:qrcp', amount: 546n },
        { recipientAddress: mintingAuthority.address, amount: 546n },
        { recipientAddress: 'bitcoincash:qchange', amount: 5908n },
      ],
    });

    const out = await buildMintPreview({
      selectedUtxos: [mintingAuthority],
      flatUtxos: [mintingAuthority, fee],
      activeOutputDrafts: [nftDraft],
      changeAddress: 'bitcoincash:qchange',
      sdkAddressBook: [],
      tokenOutputSats: 546,
    });

    expect(mocks.addOutput).toHaveBeenNthCalledWith(
      1,
      'bitcoincash:qrcp',
      546,
      0n,
      category,
      expect.arrayContaining([
        expect.objectContaining({
          tx_hash: mintingAuthority.tx_hash,
          tx_pos: mintingAuthority.tx_pos,
        }),
      ]),
      expect.any(Array),
      'mutable',
      'next'
    );
    const authorityCall = mocks.addOutput.mock.calls[1];
    expect(authorityCall[0]).toBe(mintingAuthority.address);
    expect(authorityCall[1]).toBe(546);
    expect(authorityCall[2]).toBe(0n);
    expect(authorityCall[3]).toBe(category);
    expect(authorityCall[4]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tx_hash: mintingAuthority.tx_hash,
          tx_pos: mintingAuthority.tx_pos,
        }),
      ])
    );
    expect(authorityCall[6]).toBeUndefined();
    expect(authorityCall[7]).toBeUndefined();
    expect(out.inputsForBuild).toHaveLength(2);
    expect(out.built.hex).toBe('cafe');
    expect(out.feePaid).toBe(1000n);
  });

  it('buildMintPreview rejects fungible outputs from minting authority sources', async () => {
    const category = 'd'.repeat(64);
    const mintingAuthority = makeUtxo({
      tx_hash: 'm'.repeat(64),
      tx_pos: 2,
      value: 6000,
      token: {
        category,
        amount: 0,
        nft: { capability: 'minting', commitment: 'seed' },
      },
    });
    const fee = makeUtxo({
      tx_hash: 'f'.repeat(64),
      tx_pos: 1,
      value: 2000,
      token: null,
    });

    const ftDraft = makeDraft({
      sourceKey: `${mintingAuthority.tx_hash}:${mintingAuthority.tx_pos}`,
      config: {
        mintType: 'FT',
        ftAmount: '25',
        nftCapability: 'none',
        nftCommitment: '',
      },
    });

    await expect(
      buildMintPreview({
        selectedUtxos: [mintingAuthority],
        flatUtxos: [mintingAuthority, fee],
        activeOutputDrafts: [ftDraft],
        changeAddress: 'bitcoincash:qchange',
        sdkAddressBook: [],
        tokenOutputSats: 546,
      })
    ).rejects.toThrow('Minting authority sources can only mint NFT outputs.');
  });

  it('buildMintPreview rejects non-minting NFT sources as mint inputs', async () => {
    const plainNft = makeUtxo({
      tx_hash: 'p'.repeat(64),
      tx_pos: 2,
      value: 6000,
      token: {
        category: 'p'.repeat(64),
        amount: 0,
        nft: { capability: 'none', commitment: 'seed' },
      },
    });
    const fee = makeUtxo({
      tx_hash: 'f'.repeat(64),
      tx_pos: 1,
      value: 2000,
      token: null,
    });

    const nftDraft = makeDraft({
      sourceKey: `${plainNft.tx_hash}:${plainNft.tx_pos}`,
      config: {
        mintType: 'NFT',
        ftAmount: '1',
        nftCapability: 'none',
        nftCommitment: '01',
      },
    });

    await expect(
      buildMintPreview({
        selectedUtxos: [plainNft],
        flatUtxos: [plainNft, fee],
        activeOutputDrafts: [nftDraft],
        changeAddress: 'bitcoincash:qchange',
        sdkAddressBook: [],
        tokenOutputSats: 546,
      })
    ).rejects.toThrow(
      'Only genesis UTXOs or minting authority NFTs can be used as mint sources.'
    );
  });

  it('buildMintPreview supports multiple NFT outputs from the same genesis source', async () => {
    const genesis = makeUtxo({ tx_hash: 'g'.repeat(64), tx_pos: 0, value: 7000, token: null });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 1, value: 2000, token: null });

    const draftA = makeDraft({
      id: 'draft-a',
      sourceKey: `${genesis.tx_hash}:0`,
      config: {
        mintType: 'NFT',
        ftAmount: '1',
        nftCapability: 'none',
        nftCommitment: '01',
      },
    });
    const draftB = makeDraft({
      id: 'draft-b',
      sourceKey: `${genesis.tx_hash}:0`,
      recipientCashAddr: 'bitcoincash:qrecipient2',
      config: {
        mintType: 'NFT',
        ftAmount: '1',
        nftCapability: 'none',
        nftCommitment: '02',
      },
    });

    mocks.addOutput
      .mockReturnValueOnce({
        recipientAddress: 'bitcoincash:qrcp',
        amount: 546n,
        token: {
          category: genesis.tx_hash,
          amount: 0n,
          nft: { capability: 'none', commitment: '01' },
        },
      })
      .mockReturnValueOnce({
        recipientAddress: 'bitcoincash:qrecipient2',
        amount: 546n,
        token: {
          category: genesis.tx_hash,
          amount: 0n,
          nft: { capability: 'none', commitment: '02' },
        },
      });

    mocks.buildTransaction.mockResolvedValue({
      errorMsg: '',
      hex: 'c0de',
      finalTransaction: 'c0de',
      bytecodeSize: 1,
      finalOutputs: [
        { recipientAddress: 'bitcoincash:qrcp', amount: 546n },
        { recipientAddress: 'bitcoincash:qrecipient2', amount: 546n },
        { recipientAddress: 'bitcoincash:qchange', amount: 6000n },
      ],
    });

    const out = await buildMintPreview({
      selectedUtxos: [genesis],
      flatUtxos: [genesis, fee],
      activeOutputDrafts: [draftA, draftB],
      changeAddress: 'bitcoincash:qchange',
      sdkAddressBook: [],
      tokenOutputSats: 546,
    });

    expect(mocks.addOutput).toHaveBeenCalledTimes(2);
    expect(out.inputsForBuild).toHaveLength(2);
    expect(out.built.hex).toBe('c0de');
  });

  it('buildMintPreview keeps a wallet-controlled output before BCMR OP_RETURN when enabled', async () => {
    const genesis = makeUtxo({ tx_hash: 'g'.repeat(64), tx_pos: 0, value: 5000, token: null });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 1, value: 2000, token: null });
    const draft = makeDraft({ sourceKey: `${genesis.tx_hash}:0` });

    mocks.addOutput.mockReturnValue({
      recipientAddress: 'bitcoincash:qrcp',
      amount: 546n,
      token: { category: genesis.tx_hash, amount: 1n },
    });

    mocks.buildTransaction.mockResolvedValue({
      errorMsg: '',
      hex: 'c0de',
      finalTransaction: 'c0de',
      bytecodeSize: 1,
      finalOutputs: [
        { recipientAddress: 'bitcoincash:qchange', amount: 1000n },
        { opReturn: ['BCMR'] },
        { recipientAddress: 'bitcoincash:qrcp', amount: 546n },
      ],
    });

    await buildMintPreview({
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

    const firstBuildOutputs = mocks.buildTransaction.mock.calls[0]?.[0] as Array<{
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
