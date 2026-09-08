import { describe, expect, it } from 'vitest';
import {
  binToHex,
  encodeTransaction,
  hash256,
  hexToBin,
  lockingBytecodeToCashAddress,
  privateKeyToP2pkhLockingBytecode,
  secp256k1,
} from '@bitauth/libauth';

import {
  buildCauldronMerchantPaymentPsbt,
  buildCauldronMerchantDirectPaymentRequest,
  buildCauldronMerchantPaymentRequest,
  buildCauldronPoolV0ExchangeUnlockingBytecode,
  buildCauldronPoolV0LockingBytecode,
  CAULDRON_NATIVE_BCH,
  toCauldronPoolTrade,
} from '../cauldron';
import { decodePsbt } from '../psbt/psbtBch';
import { toTokenAwareCashAddress } from '../../utils/cashAddress';

const BUYER_PRIVATE_KEY = hexToBin(
  '1111111111111111111111111111111111111111111111111111111111111111'
);
const WITHDRAW_PUBLIC_KEY_HASH = new Uint8Array(20).fill(0x22);
const TOKEN_CATEGORY = 'aa'.repeat(32);

function cashAddressFor(privateKey: Uint8Array): string {
  const lockingBytecode = privateKeyToP2pkhLockingBytecode({
    privateKey,
    throwErrors: true,
  });
  const address = lockingBytecodeToCashAddress({
    prefix: 'bitcoincash',
    bytecode: lockingBytecode,
  });
  if (typeof address === 'string') throw new Error(address);
  return address.address;
}

function parentTransaction(args: {
  lockingBytecode: Uint8Array;
  valueSatoshis: bigint;
  tokenAmount?: bigint;
}): { txid: string; hex: string } {
  const bytes = encodeTransaction({
    version: 2,
    inputs: [
      {
        outpointTransactionHash: new Uint8Array(32).fill(0x33),
        outpointIndex: 0,
        unlockingBytecode: new Uint8Array(),
        sequenceNumber: 0xffffffff,
      },
    ],
    outputs: [
      {
        lockingBytecode: args.lockingBytecode,
        valueSatoshis: args.valueSatoshis,
        token:
          args.tokenAmount === undefined
            ? undefined
            : { category: hexToBin(TOKEN_CATEGORY), amount: args.tokenAmount },
      },
    ],
    locktime: 0,
  });
  return {
    txid: binToHex(hash256(bytes).slice().reverse()),
    hex: binToHex(bytes),
  };
}

describe('Cauldron merchant payment PSBT', () => {
  it('materializes one tx with finalized LP inputs and exact buyer change', async () => {
    const poolLockingBytecode = buildCauldronPoolV0LockingBytecode({
      withdrawPublicKeyHash: WITHDRAW_PUBLIC_KEY_HASH,
    });
    const poolParent = parentTransaction({
      lockingBytecode: poolLockingBytecode,
      valueSatoshis: 10_000n,
      tokenAmount: 1_000n,
    });
    const buyerLockingBytecode = privateKeyToP2pkhLockingBytecode({
      privateKey: BUYER_PRIVATE_KEY,
      throwErrors: true,
    });
    const buyerParent = parentTransaction({
      lockingBytecode: buyerLockingBytecode,
      valueSatoshis: 20_000n,
    });
    const buyerAddress = cashAddressFor(BUYER_PRIVATE_KEY);
    const merchantAddress = toTokenAwareCashAddress(buyerAddress);
    const trade = toCauldronPoolTrade(
      {
        version: '0' as const,
        parameters: { withdrawPublicKeyHash: WITHDRAW_PUBLIC_KEY_HASH },
        txHash: poolParent.txid,
        outputIndex: 0,
        output: {
          amountSatoshis: 10_000n,
          tokenCategory: TOKEN_CATEGORY,
          tokenAmount: 1_000n,
          lockingBytecode: poolLockingBytecode,
        },
      },
      CAULDRON_NATIVE_BCH,
      TOKEN_CATEGORY,
      { supply: 5_000n, demand: 100n, tradeFee: 1n }
    );
    const built = buildCauldronMerchantPaymentRequest({
      poolTrades: [trade],
      walletInputs: [
        {
          utxo: {
            address: buyerAddress,
            tx_hash: buyerParent.txid,
            tx_pos: 0,
            value: 20_000,
            amount: 20_000,
            height: 1,
            token: null,
          },
          lockingBytecode: buyerLockingBytecode,
          pathName: 'receive',
          addressIndex: 0,
          publicKey: secp256k1.derivePublicKeyCompressed(
            BUYER_PRIVATE_KEY
          ) as Uint8Array,
          accountIndex: 0,
          coinType: 145,
        },
      ],
      merchantAddress,
      changeAddress: buyerAddress,
      feeRateSatsPerByte: 1n,
    });

    const psbt = await buildCauldronMerchantPaymentPsbt(
      built,
      new Map([
        [poolParent.txid, poolParent.hex],
        [buyerParent.txid, buyerParent.hex],
      ])
    );
    const parsed = decodePsbt(psbt);

    expect(parsed.inputs).toHaveLength(2);
    expect(parsed.inputs[0].finalScriptSig).toEqual(
      buildCauldronPoolV0ExchangeUnlockingBytecode({
        withdrawPublicKeyHash: WITHDRAW_PUBLIC_KEY_HASH,
      })
    );
    expect(parsed.inputs[1].derivations[0]?.derivationPath).toEqual([
      0x8000002c, 0x80000091, 0x80000000, 0, 0,
    ]);
    expect(parsed.outputs[1]?.token).toEqual({
      category: hexToBin(TOKEN_CATEGORY),
      amount: 100n,
    });
    expect(parsed.outputs[2]?.satoshis).toBeGreaterThan(0n);
  });

  it('requires a BCH-only input for a direct reverse token payment', () => {
    const buyerLockingBytecode = privateKeyToP2pkhLockingBytecode({
      privateKey: BUYER_PRIVATE_KEY,
      throwErrors: true,
    });
    const buyerAddress = cashAddressFor(BUYER_PRIVATE_KEY);
    const merchantAddress = toTokenAwareCashAddress(buyerAddress);
    const tokenInput = {
      utxo: {
        address: buyerAddress,
        tx_hash: '44'.repeat(32),
        tx_pos: 0,
        value: 5_000,
        amount: 5_000,
        height: 1,
        token: { category: TOKEN_CATEGORY, amount: 1_000 },
      },
      lockingBytecode: buyerLockingBytecode,
      pathName: 'receive' as const,
      addressIndex: 0,
    };
    const bchInput = {
      utxo: {
        address: buyerAddress,
        tx_hash: '55'.repeat(32),
        tx_pos: 0,
        value: 10_000,
        amount: 10_000,
        height: 1,
        token: null,
      },
      lockingBytecode: buyerLockingBytecode,
      pathName: 'receive' as const,
      addressIndex: 1,
    };

    expect(() =>
      buildCauldronMerchantDirectPaymentRequest({
        walletInputs: [tokenInput],
        merchantAddress,
        changeAddress: buyerAddress,
        paymentAsset: 'token',
        tokenCategoryHex: TOKEN_CATEGORY,
        amountAtomic: 600n,
        feeRateSatsPerByte: 1n,
      })
    ).toThrow('require an additional BCH funding UTXO');

    const built = buildCauldronMerchantDirectPaymentRequest({
      walletInputs: [tokenInput, bchInput],
      merchantAddress,
      changeAddress: buyerAddress,
      paymentAsset: 'token',
      tokenCategoryHex: TOKEN_CATEGORY,
      amountAtomic: 600n,
      feeRateSatsPerByte: 1n,
    });

    expect(built.merchantPaymentMode).toBe('direct');
    expect(built.settlementOutputs[0]).toMatchObject({
      valueSatoshis: 1_000n,
      token: { amount: 600n, category: hexToBin(TOKEN_CATEGORY) },
    });
    expect(built.settlementOutputs[1]).toMatchObject({
      valueSatoshis: 1_000n,
      token: { amount: 400n, category: hexToBin(TOKEN_CATEGORY) },
    });
    expect(built.settlementOutputs[2]?.valueSatoshis).toBeGreaterThan(0n);

    const directWithoutConversion = buildCauldronMerchantDirectPaymentRequest({
      walletInputs: [tokenInput],
      merchantAddress,
      changeAddress: buyerAddress,
      paymentAsset: 'token',
      tokenCategoryHex: TOKEN_CATEGORY,
      amountAtomic: 600n,
      requireAdditionalBchUtxo: false,
      feeRateSatsPerByte: 1n,
    });
    expect(directWithoutConversion.settlementOutputs[0]).toMatchObject({
      valueSatoshis: 1_000n,
      token: { amount: 600n, category: hexToBin(TOKEN_CATEGORY) },
    });
  });
});
