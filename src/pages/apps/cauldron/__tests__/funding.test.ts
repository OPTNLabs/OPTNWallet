import { describe, expect, it } from 'vitest';

import type { UTXO } from '../../../../types/types';
import {
  isWalletFundingUtxo,
  selectFundingUtxosByToken,
  selectLargestBchUtxos,
  sumSpendableBchBalance,
  sumSpendableTokenBalance,
} from '../funding';

function makeUtxo(overrides?: Partial<UTXO>): UTXO {
  return {
    address: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
    tx_hash: '11'.repeat(32),
    tx_pos: 0,
    value: 1000,
    amount: 1000,
    height: 0,
    token: null,
    ...overrides,
  };
}

describe('cauldron funding helpers', () => {
  it('rejects contract-managed utxos from wallet funding', () => {
    expect(
      isWalletFundingUtxo(
        makeUtxo({
          contractName: 'SomeContract',
        })
      )
    ).toBe(false);
    expect(
      isWalletFundingUtxo(
        makeUtxo({
          contractFunction: 'spend',
        })
      )
    ).toBe(false);
  });

  it('excludes contract-managed utxos from spendable balances', () => {
    const plainBch = makeUtxo({ tx_hash: '01'.repeat(32), amount: 2000, value: 2000 });
    const contractBch = makeUtxo({
      tx_hash: '02'.repeat(32),
      amount: 5000,
      value: 5000,
      contractName: 'Vault',
    });
    const plainToken = makeUtxo({
      tx_hash: '03'.repeat(32),
      token: {
        category: 'aa'.repeat(32),
        amount: 7n,
      },
      amount: 546,
      value: 546,
    });
    const contractToken = makeUtxo({
      tx_hash: '04'.repeat(32),
      token: {
        category: 'aa'.repeat(32),
        amount: 9n,
      },
      amount: 546,
      value: 546,
      contractName: 'Vault',
    });

    expect(sumSpendableBchBalance([plainBch, contractBch, plainToken])).toBe(2000n);
    expect(sumSpendableTokenBalance([plainToken, contractToken], 'aa'.repeat(32))).toBe(
      7n
    );
  });

  it('does not select contract-managed token or bch utxos for pool funding', () => {
    const contractToken = makeUtxo({
      tx_hash: '05'.repeat(32),
      token: {
        category: 'bb'.repeat(32),
        amount: 20n,
      },
      contractName: 'Vault',
      amount: 546,
      value: 546,
    });
    const plainToken = makeUtxo({
      tx_hash: '06'.repeat(32),
      token: {
        category: 'bb'.repeat(32),
        amount: 8n,
      },
      amount: 546,
      value: 546,
    });
    const plainBch = makeUtxo({
      tx_hash: '07'.repeat(32),
      amount: 8000,
      value: 8000,
    });
    const contractBch = makeUtxo({
      tx_hash: '08'.repeat(32),
      amount: 12000,
      value: 12000,
      contractFunction: 'spend',
    });

    const selectedTokens = selectFundingUtxosByToken(
      [contractToken, plainToken],
      'bb'.repeat(32),
      8n
    );
    const selectedBch = selectLargestBchUtxos([contractBch, plainBch]);

    expect(selectedTokens.selected).toEqual([plainToken]);
    expect(selectedTokens.totalAvailable).toBe(8n);
    expect(selectedBch).toEqual([plainBch]);
  });
});
