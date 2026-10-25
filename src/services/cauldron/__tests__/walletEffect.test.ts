import { describe, expect, it } from 'vitest';
import { cashAddressToLockingBytecode, hexToBin } from '@bitauth/libauth';
import type { BuiltCauldronTradeRequest } from '../tx';
import { deriveCauldronWalletEffect } from '../walletEffect';

const CHANGE_ADDRESS = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';
const TOKEN_CATEGORY = 'ab'.repeat(32);

function lockingBytecode(address: string): Uint8Array {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(decoded);
  return decoded.bytecode;
}

function builtFixture(): Pick<
  BuiltCauldronTradeRequest,
  'walletInputs' | 'settlementOutputs' | 'changeAddress' | 'tokenChangeAddress'
> {
  return {
    changeAddress: CHANGE_ADDRESS,
    tokenChangeAddress: CHANGE_ADDRESS,
    walletInputs: [
      {
        utxo: {
          address: CHANGE_ADDRESS,
          height: 1,
          tx_hash: '11'.repeat(32),
          tx_pos: 0,
          value: 20_000,
          token: { category: TOKEN_CATEGORY, amount: 10n },
        },
        lockingBytecode: lockingBytecode(CHANGE_ADDRESS),
        pathName: 'receive',
        addressIndex: 0,
      },
      {
        utxo: {
          address: CHANGE_ADDRESS,
          height: 1,
          tx_hash: '22'.repeat(32),
          tx_pos: 1,
          value: 30_000,
        },
        lockingBytecode: lockingBytecode(CHANGE_ADDRESS),
        pathName: 'receive',
        addressIndex: 0,
      },
    ],
    settlementOutputs: [
      {
        lockingBytecode: lockingBytecode(CHANGE_ADDRESS),
        valueSatoshis: 45_000n,
        token: { category: hexToBin(TOKEN_CATEGORY), amount: 6n },
      },
      {
        lockingBytecode: Uint8Array.from([0x6a]),
        valueSatoshis: 4_000n,
        token: { category: hexToBin(TOKEN_CATEGORY), amount: 4n },
      },
    ],
  };
}

describe('Cauldron wallet effect', () => {
  it('derives net BCH and token debit after wallet change', () => {
    expect(deriveCauldronWalletEffect(builtFixture(), TOKEN_CATEGORY)).toEqual({
      bchInputSats: 50_000n,
      bchReturnSats: 45_000n,
      netBchDebitSats: 5_000n,
      tokenInputAtomic: 10n,
      tokenReturnAtomic: 6n,
      netTokenDebitAtomic: 4n,
    });
  });

  it('counts a wallet settlement output as a credit', () => {
    const built = builtFixture();
    built.walletInputs = [built.walletInputs[1]!];
    built.settlementOutputs = [
      {
        lockingBytecode: lockingBytecode(CHANGE_ADDRESS),
        valueSatoshis: 39_000n,
        token: { category: hexToBin(TOKEN_CATEGORY), amount: 25n },
      },
    ];
    expect(deriveCauldronWalletEffect(built, TOKEN_CATEGORY)).toMatchObject({
      netBchDebitSats: -9_000n,
      netTokenDebitAtomic: -25n,
    });
  });
});
