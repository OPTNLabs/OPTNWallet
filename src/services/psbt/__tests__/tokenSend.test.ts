// Token sends are planned in the shared Rust core. These run the committed
// WASM binary through the TypeScript glue, so a field carried across the
// boundary wrongly (an amount, a capability, the coin-control list) fails here.
import { describe, expect, it } from 'vitest';
import { encodeCashAddress } from '@bitauth/libauth';

import type { UTXO } from '../../../types/types';
import {
  planParentTxids,
  planTokenSend,
  type TokenSendCoin,
  type TokenSendRequest,
} from '../tokenSend';
import {
  formatTokenUnits,
  tokenPaymentFor,
  type TokenAsset,
} from '../../../features/watch-only-send/tokenAssets';

const MUSD = 'b38a33f750f84c5c169a6f23cb873e6e79605021585d4f3408789689ed87f366';
const OTHER = 'ef'.repeat(32);
const NFT = 'cd'.repeat(32);

const address = (byte: number, tokens: boolean) =>
  encodeCashAddress({
    payload: new Uint8Array(20).fill(byte),
    prefix: 'bchtest',
    type: tokens ? 'p2pkhWithTokens' : 'p2pkh',
  }).address;

const WALLET = address(1, false);
const CHANGE = address(2, false);
const RECIPIENT = address(9, true);

function coin(
  txByte: string,
  vout: number,
  sats: number,
  token?: UTXO['token']
): TokenSendCoin {
  const txid = txByte.repeat(32);
  return {
    outpoint: `${txid}:${vout}`,
    utxo: {
      address: WALLET,
      height: 100,
      tx_hash: txid,
      tx_pos: vout,
      value: sats,
      token: token ?? null,
    },
    satoshis: BigInt(sats),
    publicKeyHex: '',
    branchIndex: 0,
    addressIndex: 0,
  };
}

const musd = coin('a1', 0, 1_000, { category: MUSD, amount: 1_000n });
const other = coin('a2', 0, 1_000, { category: OTHER, amount: 7n });
const nft = coin('a3', 1, 1_000, {
  category: NFT,
  amount: 5n,
  nft: { capability: 'mutable', commitment: 'beef' },
});
const bch = coin('b1', 0, 100_000);

function request(
  payment: TokenSendRequest['payment'],
  chosen?: string[]
): TokenSendRequest {
  return {
    network: 'chipnet',
    coins: [musd, other, nft, bch],
    payment,
    chosen,
    destination: RECIPIENT,
    change: CHANGE,
    feeSatsPerKb: 1_000n,
  };
}

const roles = (plan: ReturnType<typeof planTokenSend>) =>
  plan.outputs.map((output) => ({
    role: output.role,
    category: output.token?.category ?? null,
    amount: output.token?.amount ?? null,
    nft: output.token?.nft ?? null,
  }));

describe('token sends through the shared Rust planner', () => {
  it('sends an amount typed with the token decimals and returns the rest', () => {
    const plan = planTokenSend(
      request({ kind: 'fungible', category: MUSD, amount: '2.5', decimals: 2 })
    );
    expect(roles(plan)).toEqual([
      { role: 'recipient', category: MUSD, amount: '250', nft: null },
      { role: 'token_change', category: MUSD, amount: '750', nft: null },
      { role: 'change', category: null, amount: null, nft: null },
    ]);
    // Another category's coin never pays for this send.
    expect(plan.inputs.map((input) => input.outpoint)).not.toContain(
      other.outpoint
    );
    expect(planParentTxids(plan)).toEqual(
      expect.arrayContaining([musd.utxo.tx_hash, bch.utxo.tx_hash])
    );
  });

  it('sends every unit of a category, and nothing else', () => {
    const plan = planTokenSend(
      request({ kind: 'all_fungible', category: MUSD })
    );
    const recipient = plan.outputs.find(
      (output) => output.role === 'recipient'
    );
    expect(recipient?.token).toEqual({
      category: MUSD,
      amount: '1000',
      nft: null,
    });
    expect(plan.outputs.some((output) => output.role === 'token_change')).toBe(
      false
    );
  });

  it('moves an NFT as it is and keeps the fungible units on its coin', () => {
    const plan = planTokenSend(
      request({ kind: 'nft', outpoint: nft.outpoint })
    );
    expect(roles(plan)).toEqual(
      expect.arrayContaining([
        {
          role: 'recipient',
          category: NFT,
          amount: '0',
          nft: { capability: 'mutable', commitment: 'beef' },
        },
        { role: 'token_change', category: NFT, amount: '5', nft: null },
      ])
    );
  });

  it('spends exactly the coins ticked, giving their other tokens back', () => {
    const plan = planTokenSend(
      request({ kind: 'fungible', category: MUSD, amount: '1', decimals: 2 }, [
        musd.outpoint,
        other.outpoint,
        bch.outpoint,
      ])
    );
    expect(plan.inputs.map((input) => input.outpoint).sort()).toEqual(
      [musd.outpoint, other.outpoint, bch.outpoint].sort()
    );
    expect(roles(plan)).toEqual(
      expect.arrayContaining([
        { role: 'token_change', category: OTHER, amount: '7', nft: null },
      ])
    );
  });

  it('refuses rather than burn or overspend', () => {
    expect(() =>
      planTokenSend(
        request({
          kind: 'fungible',
          category: MUSD,
          amount: '10.01',
          decimals: 2,
        })
      )
    ).toThrow();
    expect(() =>
      planTokenSend({
        ...request({ kind: 'all_fungible', category: MUSD }),
        // Tokens go to token-aware addresses only.
        destination: address(9, false),
      })
    ).toThrow();
  });
});

describe('token choices in the send screen', () => {
  const ft: TokenAsset = {
    kind: 'fungible',
    category: MUSD,
    title: 'MUSD',
    categoryShort: 'b38a33f7',
    decimals: 2,
    total: 1_000n,
  };

  it('formats base units with the token decimals', () => {
    expect(formatTokenUnits(1_250n, 2)).toBe('12.5');
    expect(formatTokenUnits(1_000n, 2)).toBe('10');
    expect(formatTokenUnits(7n, 0)).toBe('7');
    expect(formatTokenUnits(5n, 3)).toBe('0.005');
  });

  it('describes the payment the holder chose', () => {
    expect(tokenPaymentFor(undefined, '1', false)).toBeNull();
    expect(tokenPaymentFor(ft, '2.5', false)).toEqual({
      kind: 'fungible',
      category: MUSD,
      amount: '2.5',
      decimals: 2,
    });
    expect(tokenPaymentFor(ft, '2.5', true)).toEqual({
      kind: 'all_fungible',
      category: MUSD,
    });
  });
});
