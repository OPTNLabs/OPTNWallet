import { beforeEach, describe, expect, it, vi } from 'vitest';
import { binToHex, encodeTransaction, hexToBin } from '@bitauth/libauth';

import type { AddonSDK } from '../../../../../services/AddonsSDK';
import type { MintAppUtxo, MintOutputDraft } from '../../types';
import { buildBcmrPublicationOpReturn } from '../bcmrOpReturn';
import { buildBootstrapPreview, buildMintPreview } from '../mintTransactions';

/** A real serialized transaction with these output scripts, for read-back. */
function transactionWithOutputs(lockingScriptsHex: string[]): string {
  return binToHex(
    encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [
        {
          outpointTransactionHash: new Uint8Array(32),
          outpointIndex: 0,
          sequenceNumber: 0,
          unlockingBytecode: new Uint8Array(),
        },
      ],
      outputs: lockingScriptsHex.map((script) => ({
        lockingBytecode: hexToBin(script),
        valueSatoshis: 0n,
      })),
    })
  );
}

const P2PKH_SCRIPT = `76a914${'11'.repeat(20)}88ac`;

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
        build: vi
          .fn()
          .mockResolvedValue({ errorMsg: 'boom', finalOutputs: null, hex: '' }),
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
        build: vi
          .fn()
          .mockResolvedValue({ errorMsg: '', finalOutputs: null, hex: '' }),
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
    ).rejects.toThrow(
      'Only genesis UTXOs or minting authority NFTs can be used as mint sources.'
    );

    const genesis = makeUtxo({
      tx_hash: 'g'.repeat(64),
      tx_pos: 0,
      value: 1000,
      token: null,
    });
    const fee = makeUtxo({
      tx_hash: 'f'.repeat(64),
      tx_pos: 1,
      value: 2000,
      token: null,
    });

    const sdkFail = {
      tx: {
        addOutput: vi.fn().mockReturnValue({
          recipientAddress: 'bitcoincash:qrcp',
          amount: 546n,
        }),
        build: vi.fn().mockResolvedValue({
          errorMsg: 'still failing',
          hex: '',
          finalOutputs: null,
        }),
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
        { recipientAddress: 'bitcoincash:qchange', amount: 1000n },
        { recipientAddress: 'bitcoincash:qrcp', amount: 546n },
        { recipientAddress: 'bitcoincash:qchange', amount: 5000n },
      ],
      finalTransaction: 'c0de',
      bytecodeSize: 123,
    });

    const genesis = makeUtxo({
      tx_hash: 'g'.repeat(64),
      tx_pos: 0,
      value: 5000,
      token: null,
    });
    const fee = makeUtxo({
      tx_hash: 'f'.repeat(64),
      tx_pos: 1,
      value: 2000,
      token: null,
    });

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
      token: {
        category: genesis.tx_hash,
        amount: 0n,
        nft: { capability: 'mutable', commitment: 'abcd' },
      },
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
      sdkAddressBook: [
        { address: 'bitcoincash:qrcp', tokenAddress: 'simpleledger:qrcp' },
      ],
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

  it('buildMintPreview supports an NFT minting authority and returns it to the wallet', async () => {
    buildTransactionMock.mockImplementationOnce(async (outputs: unknown[]) => ({
      errorMsg: '',
      finalOutputs: [
        ...outputs,
        { recipientAddress: 'bitcoincash:qchange', amount: 3000n },
      ],
      finalTransaction: 'c0de',
      bytecodeSize: 123,
    }));

    const authority = makeUtxo({
      tx_hash: 'a'.repeat(64),
      tx_pos: 1,
      value: 3000,
      token: {
        category: 'c'.repeat(64),
        amount: 0n,
        nft: { capability: 'minting', commitment: 'seed' },
      },
    });
    const fee = makeUtxo({
      tx_hash: 'f'.repeat(64),
      tx_pos: 2,
      value: 3000,
      token: null,
    });
    const draft = makeDraft({
      sourceKey: `${authority.tx_hash}:1`,
      config: {
        mintType: 'NFT',
        ftAmount: '1',
        nftCapability: 'none',
        nftCommitment: 'new',
      },
    });
    const addOutput = vi.fn().mockReturnValue({
      recipientAddress: 'bitcoincash:qrcp',
      amount: 1000n,
      token: {
        category: 'c'.repeat(64),
        amount: 0n,
        nft: { capability: 'none', commitment: 'new' },
      },
    });
    const sdk = { tx: { addOutput } } as unknown as AddonSDK;
    const addressBook = [
      { address: 'bitcoincash:qchange', tokenAddress: 'bitcoincash:zchange' },
    ];

    const out = await buildMintPreview({
      sdk,
      selectedUtxos: [authority],
      flatUtxos: [authority, fee],
      activeOutputDrafts: [draft],
      changeAddress: 'bitcoincash:qchange',
      sdkAddressBook: addressBook,
      tokenOutputSats: 1000,
    });

    expect(addOutput).toHaveBeenCalledWith(
      'bitcoincash:qrcp',
      1000,
      0n,
      'c'.repeat(64),
      [authority, fee],
      addressBook,
      'none',
      'new'
    );
    expect(out.inputsForBuild).toEqual([authority, fee]);

    // The authority is re-created, unchanged, at the wallet's token address.
    const requested = buildTransactionMock.mock.calls[0]?.[0] as Array<{
      recipientAddress?: string;
      token?: { category: string; amount: bigint; nft?: object };
    }>;
    expect(requested).toContainEqual({
      recipientAddress: 'bitcoincash:zchange',
      amount: 1000,
      token: {
        category: 'c'.repeat(64),
        amount: 0n,
        nft: { capability: 'minting', commitment: 'seed' },
      },
    });
    // Not spending an output 0, so no identity output is forced in front.
    expect(requested[0].token?.nft).toMatchObject({ capability: 'none' });
  });

  it('buildMintPreview keeps fungible tokens riding on the minting NFT', async () => {
    buildTransactionMock.mockImplementationOnce(async (outputs: unknown[]) => ({
      errorMsg: '',
      finalOutputs: outputs,
      finalTransaction: 'c0de',
      bytecodeSize: 123,
    }));
    const authority = makeUtxo({
      tx_hash: 'a'.repeat(64),
      tx_pos: 1,
      value: 3000,
      token: {
        category: 'c'.repeat(64),
        amount: '5000',
        nft: { capability: 'minting', commitment: '' },
      },
    });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 2, value: 3000 });
    const addOutput = vi.fn().mockReturnValue({
      recipientAddress: 'bitcoincash:qrcp',
      amount: 1000,
      token: {
        category: 'c'.repeat(64),
        amount: 0n,
        nft: { capability: 'none', commitment: '01' },
      },
    });

    await buildMintPreview({
      sdk: { tx: { addOutput } } as unknown as AddonSDK,
      selectedUtxos: [authority],
      flatUtxos: [authority, fee],
      activeOutputDrafts: [
        makeDraft({
          sourceKey: `${authority.tx_hash}:1`,
          config: {
            mintType: 'NFT',
            ftAmount: '1',
            nftCapability: 'none',
            nftCommitment: '01',
          },
        }),
      ],
      changeAddress: 'bitcoincash:qchange',
      sdkAddressBook: [
        { address: 'bitcoincash:qchange', tokenAddress: 'bitcoincash:zchange' },
      ],
      tokenOutputSats: 1000,
    });

    const requested = buildTransactionMock.mock.calls[0]?.[0] as Array<{
      token?: { amount: bigint; nft?: { capability: string } };
    }>;
    const returned = requested.find(
      (output) => output.token?.nft?.capability === 'minting'
    );
    expect(returned?.token?.amount).toBe(5000n);
  });

  it('buildMintPreview does not duplicate an authority the drafts already re-create', async () => {
    buildTransactionMock.mockImplementationOnce(async (outputs: unknown[]) => ({
      errorMsg: '',
      finalOutputs: outputs,
      finalTransaction: 'c0de',
      bytecodeSize: 123,
    }));
    const authority = makeUtxo({
      tx_hash: 'a'.repeat(64),
      tx_pos: 1,
      value: 3000,
      token: {
        category: 'c'.repeat(64),
        amount: 0n,
        nft: { capability: 'minting', commitment: '' },
      },
    });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 2, value: 3000 });
    const addOutput = vi.fn().mockReturnValue({
      recipientAddress: 'bitcoincash:zfriend',
      amount: 1000,
      token: {
        category: 'c'.repeat(64),
        amount: 0n,
        nft: { capability: 'minting', commitment: '' },
      },
    });

    await buildMintPreview({
      sdk: { tx: { addOutput } } as unknown as AddonSDK,
      selectedUtxos: [authority],
      flatUtxos: [authority, fee],
      activeOutputDrafts: [
        makeDraft({
          sourceKey: `${authority.tx_hash}:1`,
          config: {
            mintType: 'NFT',
            ftAmount: '1',
            nftCapability: 'minting',
            nftCommitment: '',
          },
        }),
      ],
      changeAddress: 'bitcoincash:qchange',
      sdkAddressBook: [],
      tokenOutputSats: 1000,
    });

    const requested = buildTransactionMock.mock.calls[0]?.[0] as Array<{
      token?: { nft?: { capability: string } };
    }>;
    expect(
      requested.filter((output) => output.token?.nft?.capability === 'minting')
    ).toHaveLength(1);
  });

  it('buildMintPreview refuses a build that would destroy the minting NFT', async () => {
    // A builder that drops outputs must not get past the final-output check.
    buildTransactionMock.mockResolvedValueOnce({
      errorMsg: '',
      finalOutputs: [
        { recipientAddress: 'bitcoincash:qchange', amount: 5000n },
      ],
      finalTransaction: 'c0de',
      bytecodeSize: 123,
    });
    const authority = makeUtxo({
      tx_hash: 'a'.repeat(64),
      tx_pos: 1,
      value: 3000,
      token: {
        category: 'c'.repeat(64),
        amount: 0n,
        nft: { capability: 'minting', commitment: '' },
      },
    });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 2, value: 3000 });
    const addOutput = vi.fn().mockReturnValue({
      recipientAddress: 'bitcoincash:qrcp',
      amount: 1000,
      token: {
        category: 'c'.repeat(64),
        amount: 0n,
        nft: { capability: 'none', commitment: '01' },
      },
    });

    await expect(
      buildMintPreview({
        sdk: { tx: { addOutput } } as unknown as AddonSDK,
        selectedUtxos: [authority],
        flatUtxos: [authority, fee],
        activeOutputDrafts: [
          makeDraft({
            sourceKey: `${authority.tx_hash}:1`,
            config: {
              mintType: 'NFT',
              ftAmount: '1',
              nftCapability: 'none',
              nftCommitment: '01',
            },
          }),
        ],
        changeAddress: 'bitcoincash:qchange',
        sdkAddressBook: [
          {
            address: 'bitcoincash:qchange',
            tokenAddress: 'bitcoincash:zchange',
          },
        ],
        tokenOutputSats: 1000,
      })
    ).rejects.toThrow(/minting NFT .* would be destroyed/);
  });

  it('buildMintPreview keeps output 0 in the wallet for a genesis mint without metadata', async () => {
    buildTransactionMock.mockImplementationOnce(async (outputs: unknown[]) => ({
      errorMsg: '',
      finalOutputs: outputs,
      finalTransaction: 'c0de',
      bytecodeSize: 123,
    }));
    const genesis = makeUtxo({
      tx_hash: 'g'.repeat(64),
      tx_pos: 0,
      value: 5000,
    });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 1, value: 2000 });
    const addOutput = vi.fn().mockReturnValue({
      recipientAddress: 'bitcoincash:zsomeoneelse',
      amount: 1000,
      token: { category: genesis.tx_hash, amount: 1n },
    });

    await buildMintPreview({
      sdk: { tx: { addOutput } } as unknown as AddonSDK,
      selectedUtxos: [genesis],
      flatUtxos: [genesis, fee],
      activeOutputDrafts: [makeDraft({ sourceKey: `${genesis.tx_hash}:0` })],
      changeAddress: 'bitcoincash:qchange',
      sdkAddressBook: [],
      tokenOutputSats: 1000,
    });

    const requested = buildTransactionMock.mock.calls[0]?.[0] as unknown[];
    expect(requested[0]).toEqual({
      recipientAddress: 'bitcoincash:qchange',
      amount: 1000n,
    });
    expect(requested[1]).toMatchObject({
      recipientAddress: 'bitcoincash:zsomeoneelse',
    });
  });

  it('buildMintPreview refuses a build whose output 0 left the wallet', async () => {
    buildTransactionMock.mockResolvedValueOnce({
      errorMsg: '',
      finalOutputs: [
        { recipientAddress: 'bitcoincash:zsomeoneelse', amount: 1000n },
        { recipientAddress: 'bitcoincash:qchange', amount: 5000n },
      ],
      finalTransaction: 'c0de',
      bytecodeSize: 123,
    });
    const genesis = makeUtxo({
      tx_hash: 'g'.repeat(64),
      tx_pos: 0,
      value: 5000,
    });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 1, value: 2000 });
    const addOutput = vi.fn().mockReturnValue({
      recipientAddress: 'bitcoincash:zsomeoneelse',
      amount: 1000,
      token: { category: genesis.tx_hash, amount: 1n },
    });

    await expect(
      buildMintPreview({
        sdk: { tx: { addOutput } } as unknown as AddonSDK,
        selectedUtxos: [genesis],
        flatUtxos: [genesis, fee],
        activeOutputDrafts: [makeDraft({ sourceKey: `${genesis.tx_hash}:0` })],
        changeAddress: 'bitcoincash:qchange',
        sdkAddressBook: [],
        tokenOutputSats: 1000,
      })
    ).rejects.toThrow(/output 0 must stay in this wallet/);
  });

  it('buildMintPreview will not publish metadata from a minting NFT', async () => {
    const authority = makeUtxo({
      tx_hash: 'a'.repeat(64),
      tx_pos: 1,
      value: 3000,
      token: {
        category: 'c'.repeat(64),
        amount: 0n,
        nft: { capability: 'minting', commitment: '' },
      },
    });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 2, value: 3000 });

    await expect(
      buildMintPreview({
        sdk: { tx: { addOutput: vi.fn() } } as unknown as AddonSDK,
        selectedUtxos: [authority],
        flatUtxos: [authority, fee],
        activeOutputDrafts: [
          makeDraft({ sourceKey: `${authority.tx_hash}:1` }),
        ],
        changeAddress: 'bitcoincash:qchange',
        sdkAddressBook: [],
        tokenOutputSats: 1000,
        bcmrPublication: {
          enabled: true,
          registryJson: '{"name":"demo"}',
          uris: ['ipfs://bafy123'],
        },
      })
    ).rejects.toThrow(/only be published when creating a token/);
    expect(buildTransactionMock).not.toHaveBeenCalled();
  });

  it('buildMintPreview keeps a wallet-controlled output before BCMR OP_RETURN when enabled', async () => {
    const { scriptHex } = buildBcmrPublicationOpReturn({
      registryJson: '{"name":"demo"}',
      uris: ['ipfs://bafy123'],
    });
    buildTransactionMock.mockResolvedValueOnce({
      errorMsg: '',
      finalOutputs: [
        { recipientAddress: 'bitcoincash:qchange', amount: 1000n },
        { opReturn: ['BCMR'] },
        { recipientAddress: 'bitcoincash:qrcp', amount: 546n },
      ],
      finalTransaction: transactionWithOutputs([
        P2PKH_SCRIPT,
        scriptHex,
        P2PKH_SCRIPT,
      ]),
      bytecodeSize: 123,
    });

    const genesis = makeUtxo({
      tx_hash: 'g'.repeat(64),
      tx_pos: 0,
      value: 5000,
      token: null,
    });
    const fee = makeUtxo({
      tx_hash: 'f'.repeat(64),
      tx_pos: 1,
      value: 2000,
      token: null,
    });
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

  it('buildMintPreview refuses a transaction that publishes different metadata', async () => {
    const genesis = makeUtxo({
      tx_hash: 'g'.repeat(64),
      tx_pos: 0,
      value: 5000,
    });
    const fee = makeUtxo({ tx_hash: 'f'.repeat(64), tx_pos: 1, value: 2000 });
    const params = {
      sdk: {
        tx: {
          addOutput: vi.fn().mockReturnValue({
            recipientAddress: 'bitcoincash:qrcp',
            amount: 546n,
            token: { category: genesis.tx_hash, amount: 1n },
          }),
        },
      } as unknown as AddonSDK,
      selectedUtxos: [genesis],
      flatUtxos: [genesis, fee],
      activeOutputDrafts: [makeDraft({ sourceKey: `${genesis.tx_hash}:0` })],
      changeAddress: 'bitcoincash:qchange',
      sdkAddressBook: [],
      tokenOutputSats: 546,
      bcmrPublication: {
        enabled: true,
        registryJson: '{"name":"demo"}',
        uris: ['ipfs://bafy123'],
      },
    };
    const finalOutputs = [
      { recipientAddress: 'bitcoincash:qchange', amount: 1000n },
      { opReturn: ['BCMR'] },
    ];

    const other = buildBcmrPublicationOpReturn({
      registryJson: '{"name":"someone else"}',
      uris: ['ipfs://bafy123'],
    });
    buildTransactionMock.mockResolvedValueOnce({
      errorMsg: '',
      finalOutputs,
      finalTransaction: transactionWithOutputs([P2PKH_SCRIPT, other.scriptHex]),
      bytecodeSize: 123,
    });
    await expect(buildMintPreview(params)).rejects.toThrow(
      /does not publish the uploaded token metadata/
    );

    const otherUri = buildBcmrPublicationOpReturn({
      registryJson: '{"name":"demo"}',
      uris: ['ipfs://bafyELSEWHERE'],
    });
    buildTransactionMock.mockResolvedValueOnce({
      errorMsg: '',
      finalOutputs,
      finalTransaction: transactionWithOutputs([
        P2PKH_SCRIPT,
        otherUri.scriptHex,
      ]),
      bytecodeSize: 123,
    });
    await expect(buildMintPreview(params)).rejects.toThrow(
      /does not publish the uploaded token metadata/
    );

    buildTransactionMock.mockResolvedValueOnce({
      errorMsg: '',
      finalOutputs,
      finalTransaction: transactionWithOutputs([P2PKH_SCRIPT]),
      bytecodeSize: 123,
    });
    await expect(buildMintPreview(params)).rejects.toThrow(
      /does not publish the uploaded token metadata/
    );
  });
});
