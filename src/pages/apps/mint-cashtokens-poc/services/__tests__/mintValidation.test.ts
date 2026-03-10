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
      'Select at least one Candidate UTXO.'
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
    ).toBe('An output references an unselected Candidate UTXO.');
  });

  it('rejects non-positive FT amount and duplicated NFT category', () => {
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

    const d2: MintOutputDraft = {
      ...baseDraft,
      id: 'd2',
      config: {
        ...baseDraft.config,
        mintType: 'NFT',
        nftCapability: 'none',
        nftCommitment: 'ab',
      },
    };

    const err = validateMintRequest({
      ...validParams(),
      activeOutputDrafts: [baseDraft, d2],
    });

    expect(err).toContain('Category');
    expect(err).toContain('must be FT');
  });
});
