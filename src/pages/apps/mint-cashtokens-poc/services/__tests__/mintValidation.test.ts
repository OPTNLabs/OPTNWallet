import { describe, expect, it } from 'vitest';

import type { MintAppUtxo, MintOutputDraft } from '../../types';
import { validateMintRequest } from '../mintValidation';

const baseUtxo: MintAppUtxo = {
  address: 'bitcoincash:qsrc',
  height: 0,
  tx_hash: 'g'.repeat(64),
  tx_pos: 0,
  value: 1000,
  token: null,
} as MintAppUtxo;

const baseDraft: MintOutputDraft = {
  id: 'd1',
  recipientCashAddr: 'bitcoincash:qrcp',
  sourceKey: `${baseUtxo.tx_hash}:${baseUtxo.tx_pos}`,
  config: {
    mintType: 'FT',
    ftAmount: '1',
    nftCapability: 'none',
    nftCommitment: '',
  },
};

function validParams() {
  return {
    walletId: 1,
    selectedRecipientCount: 1,
    changeAddress: 'bitcoincash:qchange',
    selectedUtxos: [baseUtxo],
    activeOutputDrafts: [baseDraft],
    selectedRecipientSet: new Set([baseDraft.recipientCashAddr]),
    selectedSourceKeySet: new Set([baseDraft.sourceKey]),
  };
}

describe('validateMintRequest', () => {
  it('returns null when request is valid', () => {
    expect(validateMintRequest(validParams())).toBeNull();
  });

  it('returns wallet/recipient/change/input/output guard errors', () => {
    expect(validateMintRequest({ ...validParams(), walletId: 0 })).toBe(
      'No wallet selected.'
    );
    expect(
      validateMintRequest({ ...validParams(), selectedRecipientCount: 0 })
    ).toBe('Please select at least one recipient address.');
    expect(validateMintRequest({ ...validParams(), changeAddress: '' })).toBe(
      'Change address not ready.'
    );
    expect(validateMintRequest({ ...validParams(), selectedUtxos: [] })).toBe(
      'Select at least one source UTXO.'
    );
    expect(
      validateMintRequest({ ...validParams(), activeOutputDrafts: [] })
    ).toBe('Add at least one output mapping in Amounts.');
  });

  it('rejects unselected recipient/source references', () => {
    expect(
      validateMintRequest({
        ...validParams(),
        selectedRecipientSet: new Set<string>(),
      })
    ).toBe('An output references an unselected recipient.');

    expect(
      validateMintRequest({
        ...validParams(),
        selectedSourceKeySet: new Set<string>(),
      })
    ).toBe('An output references an unselected source UTXO.');
  });

  it('rejects plain NFT sources and FT outputs from minting authorities', () => {
    const plainSource: MintAppUtxo = {
      ...baseUtxo,
      tx_hash: 'p'.repeat(64),
      tx_pos: 1,
      token: {
        category: 'p'.repeat(64),
        amount: 0,
        nft: { capability: 'none', commitment: 'seed' },
      },
    };
    const mintingSource: MintAppUtxo = {
      ...baseUtxo,
      tx_hash: 'm'.repeat(64),
      tx_pos: 2,
      token: {
        category: 'm'.repeat(64),
        amount: 0,
        nft: { capability: 'minting', commitment: 'seed' },
      },
    };

    expect(
      validateMintRequest({
        ...validParams(),
        selectedUtxos: [plainSource],
        activeOutputDrafts: [
          {
            ...baseDraft,
            sourceKey: `${plainSource.tx_hash}:${plainSource.tx_pos}`,
          },
        ],
        selectedRecipientSet: new Set([baseDraft.recipientCashAddr]),
        selectedSourceKeySet: new Set([
          `${plainSource.tx_hash}:${plainSource.tx_pos}`,
        ]),
      })
    ).toBe('Only genesis UTXOs or minting authority NFTs can be used as mint sources.');

    expect(
      validateMintRequest({
        ...validParams(),
        selectedUtxos: [mintingSource],
        activeOutputDrafts: [
          {
            ...baseDraft,
            sourceKey: `${mintingSource.tx_hash}:${mintingSource.tx_pos}`,
          },
        ],
        selectedRecipientSet: new Set([baseDraft.recipientCashAddr]),
        selectedSourceKeySet: new Set([
          `${mintingSource.tx_hash}:${mintingSource.tx_pos}`,
        ]),
      })
    ).toBe('Minting authority sources can only mint NFT outputs.');
  });

  it('rejects selected sources that do not have any output mapping', () => {
    const extraSource: MintAppUtxo = {
      ...baseUtxo,
      tx_hash: 'f'.repeat(64),
      tx_pos: 1,
      token: {
        category: 'f'.repeat(64),
        amount: 0,
        nft: { capability: 'minting', commitment: 'seed' },
      },
    };

    expect(
      validateMintRequest({
        ...validParams(),
        selectedUtxos: [baseUtxo, extraSource],
        selectedSourceKeySet: new Set([
          `${baseUtxo.tx_hash}:${baseUtxo.tx_pos}`,
          `${extraSource.tx_hash}:${extraSource.tx_pos}`,
        ]),
      })
    ).toBe('Each selected source UTXO needs at least one output mapping.');
  });

  it('rejects non-positive FT amount and allows multiple NFT outputs from genesis', () => {
    expect(
      validateMintRequest({
        ...validParams(),
        activeOutputDrafts: [
          {
            ...baseDraft,
            config: { ...baseDraft.config, mintType: 'FT', ftAmount: '0' },
          },
        ],
      })
    ).toContain('FT amount must be > 0');

    const nftDraftA: MintOutputDraft = {
      ...baseDraft,
      id: 'd2',
      config: {
        ...baseDraft.config,
        mintType: 'NFT',
        nftCapability: 'none',
        nftCommitment: 'ab',
      },
    };
    const nftDraftB: MintOutputDraft = {
      ...baseDraft,
      id: 'd3',
      config: {
        ...baseDraft.config,
        mintType: 'NFT',
        nftCapability: 'none',
        nftCommitment: 'cd',
      },
    };

    expect(
      validateMintRequest({
        ...validParams(),
        activeOutputDrafts: [nftDraftA, nftDraftB],
      })
    ).toBeNull();
  });
});
