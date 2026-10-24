import { describe, expect, it } from 'vitest';
import {
  binToHex,
  createVirtualMachineBCH,
  decodeTransaction,
  hash256,
  hexToBin,
  verifyTransactionTokens,
} from '@bitauth/libauth';
import corpus from '../../../../test-vectors/seedcash-cashtokens.json';
import {
  ensureOptnCore,
  psbtFinalizeCashTokensP2pkh,
  psbtReviewP2pkh,
} from '../../../wasm/optn-core';

function decode(hex: string) {
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === 'string') throw new Error(tx);
  return tx;
}

describe('shared Rust CashTokens PSBTs and independent BCH VM', () => {
  ensureOptnCore();
  const vm = createVirtualMachineBCH();
  for (const fixture of corpus.cases) {
    it(fixture.id, () => {
      const original = hexToBin(fixture.psbt_hex);
      const review = () => psbtReviewP2pkh(original, 'chipnet');
      if (fixture.expected_review_success) {
        const result = JSON.parse(review());
        for (const output of [...result.spent_outputs, ...result.outputs]) {
          if (output.token) expect(typeof output.token.amount).toBe('string');
        }
      } else expect(review).toThrow();
      const transaction = decode(fixture.unsigned_transaction_hex);
      const parents = new Map(
        fixture.source_transactions.map((raw) => [
          binToHex(hash256(hexToBin(raw)).slice().reverse()),
          decode(raw),
        ])
      );
      const sourceOutputs = transaction.inputs.map((input) => {
        const parent = parents.get(binToHex(input.outpointTransactionHash));
        if (!parent) throw new Error('fixture is missing a parent');
        return parent.outputs[input.outpointIndex];
      });
      expect(
        verifyTransactionTokens(transaction, sourceOutputs, {
          maximumTokenCommitmentLength: 40,
        }) === true
      ).toBe(fixture.expected_tokens_valid);
      if (!('signed_psbt_hex' in fixture) || !fixture.signed_psbt_hex) return;
      const finalize = () =>
        psbtFinalizeCashTokensP2pkh(
          original,
          hexToBin(fixture.signed_psbt_hex!),
          'chipnet'
        );
      if (!('raw_transaction_hex' in fixture) || !fixture.raw_transaction_hex) {
        expect(finalize).toThrow();
        return;
      }
      const raw = finalize();
      expect(binToHex(raw)).toBe(fixture.raw_transaction_hex);
      expect(
        vm.verify({ sourceOutputs, transaction: decode(binToHex(raw)) })
      ).toBe(true);
      expect(() =>
        psbtFinalizeCashTokensP2pkh(
          original,
          hexToBin(fixture.signed_psbt_hex!),
          'mainnet'
        )
      ).toThrow();
    });
  }
});
