import { describe, expect, it } from 'vitest';
import type { UTXO } from '../../../types/types';
import type { AddonTransactionProposal } from '../../AddonsSDK';
import { assertAddonWalletInputState } from '../AddonInputStateVerifier';

const category = 'a'.repeat(64);

const baseProposal = (): AddonTransactionProposal => ({
  proposalId: 'proposal-input-state',
  commitmentHex: 'b'.repeat(64),
  walletId: 1,
  network: 'chipnet',
  sessionId: 'session-1',
  grantRevision: 1,
  authorityEpoch: 1,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  inputs: [
    {
      txid: 'c'.repeat(64),
      vout: 0,
      address: 'bitcoincash:qqinput',
      valueSats: '2000',
      tokenCategory: category,
      tokenAmount: '5',
      tokenNft: { capability: 'none', commitment: '01' },
    },
  ],
  outputs: [],
  status: 'proposed',
});

const actualInput = (): UTXO => ({
  tx_hash: 'c'.repeat(64),
  tx_pos: 0,
  address: 'bitcoincash:qqinput',
  value: 2000,
  amount: 2000,
  height: 1,
  token: {
    category,
    amount: 5n,
    nft: { capability: 'none', commitment: '01' },
  },
});

describe('addon wallet input state verifier', () => {
  it('accepts an exact wallet-owned BCH/CashToken state match', () => {
    expect(
      assertAddonWalletInputState({
        proposal: baseProposal(),
        actualInputs: [actualInput()],
      })
    ).toBeUndefined();
  });

  it('rejects stale value, token, address, duplicate, and contract state', () => {
    for (const mutate of [
      (input: UTXO) => ({ ...input, value: 1999 }),
      (input: UTXO) => ({ ...input, token: { ...input.token!, amount: 4n } }),
      (input: UTXO) => ({ ...input, address: 'bitcoincash:qqother' }),
      (input: UTXO) => ({ ...input, contractName: 'unexpected' }),
    ]) {
      expect(() =>
        assertAddonWalletInputState({
          proposal: baseProposal(),
          actualInputs: [mutate(actualInput())],
        })
      ).toThrow();
    }

    expect(() =>
      assertAddonWalletInputState({
        proposal: baseProposal(),
        actualInputs: [actualInput(), actualInput()],
      })
    ).toThrow(/duplicate outpoint/i);
  });

  it('rejects an outpoint absent from the fresh wallet set', () => {
    expect(() =>
      assertAddonWalletInputState({
        proposal: baseProposal(),
        actualInputs: [],
      })
    ).toThrow(/no longer spendable/i);
  });

  it('rejects unsafe numeric wallet values instead of rounding them', () => {
    expect(() =>
      assertAddonWalletInputState({
        proposal: baseProposal(),
        actualInputs: [
          { ...actualInput(), value: Number.MAX_SAFE_INTEGER + 2 },
        ],
      })
    ).toThrow(/unsafe BCH value/i);

    expect(() =>
      assertAddonWalletInputState({
        proposal: baseProposal(),
        actualInputs: [
          {
            ...actualInput(),
            token: {
              ...actualInput().token!,
              amount: Number.MAX_SAFE_INTEGER + 2,
            },
          },
        ],
      })
    ).toThrow(/unsafe token amount/i);
  });

  it('rejects malformed numeric provider and proposal values', () => {
    expect(() =>
      assertAddonWalletInputState({
        proposal: baseProposal(),
        actualInputs: [
          { ...actualInput(), value: 'not-a-number' as never },
        ],
      })
    ).toThrow(/invalid BCH value/i);
    expect(() =>
      assertAddonWalletInputState({
        proposal: {
          ...baseProposal(),
          inputs: [
            { ...baseProposal().inputs[0], tokenAmount: 'not-a-number' },
          ],
        },
        actualInputs: [actualInput()],
      })
    ).toThrow(/invalid token amount/i);
  });

  it('rejects malformed provider CashToken metadata', () => {
    expect(() =>
      assertAddonWalletInputState({
        proposal: baseProposal(),
        actualInputs: [
          {
            ...actualInput(),
            token: { ...actualInput().token!, category: 'invalid' },
          },
        ],
      })
    ).toThrow(/invalid token category/i);
    expect(() =>
      assertAddonWalletInputState({
        proposal: baseProposal(),
        actualInputs: [
          {
            ...actualInput(),
            token: { ...actualInput().token!, amount: 0n, nft: undefined },
          },
        ],
      })
    ).toThrow(/zero fungible token amount/i);
  });

  it('rejects conflicting current and legacy token fields', () => {
    const actual = actualInput();
    expect(() =>
      assertAddonWalletInputState({
        proposal: baseProposal(),
        actualInputs: [
          {
            ...actual,
            token_data: { ...actual.token!, amount: 4n },
          },
        ],
      })
    ).toThrow(/conflicting token state/i);
  });

  it('rejects malformed provider and proposal outpoints', () => {
    expect(() =>
      assertAddonWalletInputState({
        proposal: baseProposal(),
        actualInputs: [{ ...actualInput(), tx_hash: 'invalid' }],
      })
    ).toThrow(/outpoint is invalid/i);
    expect(() =>
      assertAddonWalletInputState({
        proposal: {
          ...baseProposal(),
          inputs: [{ ...baseProposal().inputs[0], vout: -1 }],
        },
        actualInputs: [actualInput()],
      })
    ).toThrow(/outpoint is invalid/i);
  });

  it('accepts equivalent token fields regardless of property ordering', () => {
    const actual = actualInput();
    expect(() =>
      assertAddonWalletInputState({
        proposal: baseProposal(),
        actualInputs: [
          {
            ...actual,
            token_data: {
              nft: { commitment: '01', capability: 'none' },
              amount: 5n,
              category,
            },
          },
        ],
      })
    ).not.toThrow();
  });
});
