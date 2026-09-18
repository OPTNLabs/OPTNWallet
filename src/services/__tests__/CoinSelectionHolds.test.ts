import { describe, expect, it } from 'vitest';
import {
  selectForBch,
  selectNftInput,
  selectTokenFtInputs,
} from '../CoinSelectionService';
import type { UTXO } from '../../types/types';

const coin = (txid: string, pos: number, sats: number): UTXO =>
  ({
    tx_hash: txid,
    tx_pos: pos,
    value: sats,
    amount: sats,
    height: 100,
    address: 'bitcoincash:qtest',
  }) as unknown as UTXO;

const tokenCoin = (txid: string, pos: number, amount: bigint, nft = false): UTXO =>
  ({
    ...coin(txid, pos, 1000),
    token: {
      category: 'cat',
      amount,
      ...(nft ? { nft: { commitment: 'ab', capability: 'none' } } : {}),
    },
  }) as unknown as UTXO;

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('coin selection respects held coins', () => {
  it('never spends a held coin, even when it is the only one big enough', () => {
    // The hold may belong to a Flipstarter pledge or a running Fusion round:
    // spending it double-spends that round's own inputs. Preferring it because
    // it is large is exactly the failure this prevents.
    const held = new Set([`${A}:0`]);
    const result = selectForBch(BigInt(90_000), [coin(A, 0, 100_000), coin(B, 0, 95_000)], {
      heldOutpoints: held,
    });
    expect(result.selected.map((u) => u.tx_hash)).toEqual([B]);
  });

  it('matches a held coin whatever case the txid arrives in', () => {
    // The record stores lower-case; a UTXO from another source may not.
    const held = new Set([`${A}:1`]);
    const result = selectForBch(BigInt(1_000), [coin(A.toUpperCase(), 1, 50_000)], {
      heldOutpoints: held,
    });
    expect(result.selected).toEqual([]);
  });

  it('leaves selection unchanged when nothing is held', () => {
    const result = selectForBch(BigInt(1_000), [coin(A, 0, 50_000)]);
    expect(result.selected).toHaveLength(1);
  });

  it('holds tokens and NFTs too, not only BCH', () => {
    const held = new Set([`${A}:0`]);
    const { tokenInputs } = selectTokenFtInputs(
      'cat',
      [tokenCoin(A, 0, 500n), tokenCoin(B, 0, 500n)],
      400n,
      { heldOutpoints: held }
    );
    expect(tokenInputs.map((u) => u.tx_hash)).toEqual([B]);

    expect(
      selectNftInput('cat', [tokenCoin(A, 0, 0n, true)], { heldOutpoints: held })
    ).toBeNull();
  });
});
