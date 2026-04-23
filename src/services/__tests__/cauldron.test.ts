import { describe, expect, it } from 'vitest';
import MockNetworkProvider from 'cashscript/dist/network/MockNetworkProvider.js';
import {
  CompilationContextBCH,
  SigningSerializationFlag,
  binToHex,
  createVirtualMachineBCH,
  encodeTransaction,
  generateSigningSerializationBCH,
  generateTransaction,
  hash160,
  hash256,
  hexToBin,
  importWalletTemplate,
  lockingBytecodeToCashAddress,
  privateKeyToP2pkhLockingBytecode,
  secp256k1,
  walletTemplateP2pkhNonHd,
  walletTemplateToCompilerBCH,
  type Input,
  type Output,
  type Transaction,
  type TransactionTemplateFixed,
} from '@bitauth/libauth';

import {
  CAULDRON_NATIVE_BCH,
  buildCauldronPoolDepositRequest,
  buildCauldronPoolV0ExchangeUnlockingBytecode,
  buildCauldronPoolV0LockingBytecode,
  buildCauldronPoolV0RedeemScript,
  buildCauldronPoolWithdrawRequest,
  buildCauldronTradeRequest,
  assertSignedTransactionCovenantValidity,
  assertSignedTransactionFeeSufficiency,
  analyzeCauldronMarketLiquidity,
  calculateSignedTransactionFeeSatoshis,
  calcCauldronPairRate,
  calcCauldronTradeFee,
  calcCauldronTradeWithTargetDemand,
  calcCauldronTradeWithTargetSupply,
  createCauldronPoolPair,
  extractCauldronPoolV0ParametersFromUnlockingBytecode,
  formatPoolOutpoint,
  getCauldronPoolV0WithdrawPublicKeyHash,
  normalizeCauldronPoolRow,
  normalizeCauldronTokenRow,
  detectCauldronWalletPoolPositions,
  planAggregatedTradeForTargetDemand,
  planAggregatedTradeForTargetSupply,
  planBestSinglePoolTradeForTargetDemand,
  toCauldronPoolTrade,
  tryParseCauldronPoolFromUtxo,
} from '../cauldron';
import type { ContractInfo } from '../../types/wcInterfaces';

const TEST_PRIVATE_KEY = hexToBin(
  '1111111111111111111111111111111111111111111111111111111111111111'
);

const WITHDRAW_PKH = Uint8Array.from([
  0xb0, 0x34, 0xdc, 0x78, 0x21, 0xb2, 0xb2, 0x5c, 0x38, 0xb5,
  0x82, 0x5c, 0xdc, 0x4a, 0xf9, 0xe6, 0xac, 0xe0, 0x2b, 0xe7,
]);
const TEST_CASHADDR =
  'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';

function signRequestForTest(args: {
  signRequest: {
    inputPaths: Array<[number, string, number]>;
    transaction: {
      transaction: TransactionTemplateFixed<any>;
      sourceOutputs: Array<Input & Output & ContractInfo>;
    };
  };
  keyByInputIndex: Map<number, Uint8Array>;
}) {
  const template = importWalletTemplate(walletTemplateP2pkhNonHd);
  if (typeof template === 'string') {
    throw new Error(template);
  }

  const compiler = walletTemplateToCompilerBCH(template);
  const transaction = {
    ...args.signRequest.transaction.transaction,
    inputs: args.signRequest.transaction.transaction.inputs.map((input) => ({
      ...input,
    })),
  } as TransactionTemplateFixed<typeof compiler>;
  const sourceOutputs = args.signRequest.transaction.sourceOutputs;

  for (let i = 0; i < transaction.inputs.length; i += 1) {
    const key = args.keyByInputIndex.get(i);
    if (!key) continue;

    const sourceOutput = sourceOutputs[i];
    if (!sourceOutput) {
      throw new Error(`Missing source output for input ${i}`);
    }

    if (sourceOutput.contract?.artifact?.contractName) {
      let unlockingHex = binToHex(sourceOutput.unlockingBytecode);
      const sigPlaceholder = '41' + binToHex(new Uint8Array(65).fill(0));
      const pubkeyPlaceholder = '21' + binToHex(new Uint8Array(33).fill(0));
      const signingSerializationType =
        SigningSerializationFlag.allOutputs |
        SigningSerializationFlag.utxos |
        SigningSerializationFlag.forkId;
      const context = {
        inputIndex: i,
        sourceOutputs,
        transaction: transaction as Transaction,
      } as CompilationContextBCH;
      const preimage = generateSigningSerializationBCH(context, {
        coveredBytecode: sourceOutput.contract.redeemScript,
        signingSerializationType: new Uint8Array([signingSerializationType]),
      });
      const sighash = hash256(preimage);
      const signature = secp256k1.signMessageHashSchnorr(
        key,
        sighash
      ) as Uint8Array;
      const pubkey = secp256k1.derivePublicKeyCompressed(key) as Uint8Array;

      unlockingHex = unlockingHex
        .replace(
          sigPlaceholder,
          '41' + binToHex(Uint8Array.from([...signature, signingSerializationType]))
        )
        .replace(pubkeyPlaceholder, '21' + binToHex(pubkey));

      transaction.inputs[i] = {
        ...transaction.inputs[i],
        unlockingBytecode: hexToBin(unlockingHex),
      };
      continue;
    }

    transaction.inputs[i] = {
      ...transaction.inputs[i],
      unlockingBytecode: {
        compiler,
        data: { keys: { privateKeys: { key } } },
        valueSatoshis: sourceOutput.valueSatoshis,
        script: 'unlock',
        token: sourceOutput.token,
      },
    };
  }

  const generated = generateTransaction(transaction);
  if (!generated.success) {
    throw new Error('Failed to sign Cauldron test transaction');
  }
  return {
    sourceOutputs,
    transaction: generated.transaction,
  };
}

function toCashAddress(value: string | { address: string }): string {
  return typeof value === 'string' ? value : value.address;
}

function expectVmAccepts(args: {
  sourceOutputs: Array<Input & Output & ContractInfo>;
  transaction: Transaction;
}) {
  const vm = createVirtualMachineBCH();
  const result = vm.verify({
    sourceOutputs: args.sourceOutputs,
    transaction: args.transaction,
  });
  if (typeof result === 'string') {
    throw new Error(result);
  }
}

function createWalletInputFixture(options?: {
  address?: string;
  txHash?: string;
  txPos?: number;
  value?: number | bigint;
  token?: {
    category: string;
    amount: bigint;
  };
}) {
  const lockingBytecode = privateKeyToP2pkhLockingBytecode({
    privateKey: TEST_PRIVATE_KEY,
    throwErrors: true,
  });
  const addressResult = lockingBytecodeToCashAddress({
    prefix: 'bitcoincash',
    bytecode: lockingBytecode,
  });
  if (typeof addressResult === 'string') {
    throw new Error(addressResult);
  }
  const address = toCashAddress(addressResult);

  const value = Number(options?.value ?? 2_000_000_000n);

  return {
    utxo: {
      address: options?.address ?? address,
      tx_hash: options?.txHash ?? '22'.repeat(32),
      tx_pos: options?.txPos ?? 1,
      value,
      amount: value,
      height: 0,
      token: options?.token
        ? {
            category: options.token.category,
            amount: options.token.amount,
          }
        : null,
    },
    lockingBytecode,
    pathName: 'receive' as const,
    addressIndex: 0,
  };
}

describe('Cauldron service', () => {
  it('builds and parses a Cauldron pool script without any network-specific branch', () => {
    const redeemScript = buildCauldronPoolV0RedeemScript({
      withdrawPublicKeyHash: WITHDRAW_PKH,
    });
    const parsedPkh = getCauldronPoolV0WithdrawPublicKeyHash(redeemScript);

    expect(parsedPkh).not.toBeNull();
    expect(Array.from(parsedPkh ?? [])).toEqual(Array.from(WITHDRAW_PKH));

    const unlocking = buildCauldronPoolV0ExchangeUnlockingBytecode({
      withdrawPublicKeyHash: WITHDRAW_PKH,
    });
    const parsedUnlocking = extractCauldronPoolV0ParametersFromUnlockingBytecode(
      unlocking
    );

    expect(parsedUnlocking?.kind).toBe('trade');
    expect(Array.from(parsedUnlocking?.parameters.withdrawPublicKeyHash ?? [])).toEqual(
      Array.from(WITHDRAW_PKH)
    );
  });

  it('parses a pool utxo when the locking bytecode matches the Cauldron script', () => {
    const lockingBytecode = buildCauldronPoolV0LockingBytecode({
      withdrawPublicKeyHash: WITHDRAW_PKH,
    });
    const pool = tryParseCauldronPoolFromUtxo(
      {
        tx_hash: 'ab'.repeat(32),
        tx_pos: 0,
        value: 1_000_000,
        token: {
          category:
            'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
          amount: 1_138_899_210_697n,
        },
        lockingBytecode,
      },
      { withdrawPublicKeyHash: WITHDRAW_PKH }
    );

    expect(pool).not.toBeNull();
    expect(pool?.output.amountSatoshis).toBe(1_000_000n);
    expect(pool?.output.tokenAmount).toBe(1_138_899_210_697n);
  });

  it('computes Cauldron trade math for a BCH to token trade', () => {
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: WITHDRAW_PKH },
      txHash: 'cd'.repeat(32),
      outputIndex: 0,
      output: {
        amountSatoshis: 6_431_059_787n,
        tokenCategory:
          'b79bfc8246b5fc4707e7c7dedcb6619ef1ab91f494a790c20b0f4c422ed95b92',
        tokenAmount: 163n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: WITHDRAW_PKH,
        }),
      },
    };

    const pair = createCauldronPoolPair(
      pool,
      CAULDRON_NATIVE_BCH,
      pool.output.tokenCategory
    );
    const trade = calcCauldronTradeWithTargetDemand(pair, 1n);

    expect(calcCauldronTradeFee(1_000n)).toBe(3n);
    expect(calcCauldronPairRate(pair, 1_000_000n) > 0n).toBe(true);
    expect(trade).not.toBeNull();
    expect(trade?.demand).toBe(1n);
    expect(trade && trade.supply > 0n).toBe(true);
  });

  it('normalizes API rows and plans a best single-pool trade', () => {
    const row = {
      txid: 'ef'.repeat(32),
      vout: 2,
      value: '1000000',
      token_id:
        'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
      token_amount: '1138899210697',
      withdraw_pubkey_hash:
        'b034dc7821b2b25c38b5825cdc4af9e6ace02be7',
    };

    const normalized = normalizeCauldronPoolRow(row);
    expect(normalized).not.toBeNull();
    expect(formatPoolOutpoint(normalized as NonNullable<typeof normalized>)).toBe(
      `${row.txid}:2`
    );

    const plan = planBestSinglePoolTradeForTargetDemand(
      [normalized as NonNullable<typeof normalized>],
      CAULDRON_NATIVE_BCH,
      row.token_id,
      1n
    );

    expect(plan).not.toBeNull();
    expect(plan?.trade.pool.txHash).toBe(row.txid);
    expect(plan && plan.summary.demand >= 1n).toBe(true);
  });

  it('normalizes active-pool indexer rows that use owner_pkh', () => {
    const normalized = normalizeCauldronPoolRow({
      txid: 'ef'.repeat(32),
      tx_pos: 2,
      sats: 1000000,
      token_id:
        'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
      tokens: 1138899210697,
      owner_pkh: 'b034dc7821b2b25c38b5825cdc4af9e6ace02be7',
      owner_p2pkh_addr: TEST_CASHADDR,
      pool_id: 'aa'.repeat(32),
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.ownerAddress).toBe(TEST_CASHADDR);
    expect(normalized?.poolId).toBe('aa'.repeat(32));
  });

  it('preserves exact bigint reserves when normalizing pool rows', () => {
    const normalized = normalizeCauldronPoolRow({
      txid: 'ab'.repeat(32),
      tx_pos: 3,
      sats: '1234567890123456',
      token_id:
        'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
      token_amount: '987654321098765432',
      owner_pkh: 'b034dc7821b2b25c38b5825cdc4af9e6ace02be7',
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.output.amountSatoshis).toBe(1_234_567_890_123_456n);
    expect(normalized?.output.tokenAmount).toBe(987_654_321_098_765_432n);
  });

  it('normalizes live Rostrum pool rows from cauldron.contract.subscribe', () => {
    const normalized = normalizeCauldronPoolRow({
      new_utxo_txid: '12'.repeat(32),
      new_utxo_n: 1,
      sats: 1000000,
      token_id:
        'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
      token_amount: 1138899210697,
      pkh: 'b034dc7821b2b25c38b5825cdc4af9e6ace02be7',
      is_withdrawn: false,
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.txHash).toBe('12'.repeat(32));
    expect(normalized?.outputIndex).toBe(1);
  });

  it('normalizes cached token rows from the riften indexer payload shape', () => {
    const normalized = normalizeCauldronTokenRow({
      token_id:
        'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
      display_name: 'Breakfast Token',
      display_symbol: 'BREAKFAST',
      bcmr: {
        token: { category: 'ignored', decimals: 2, symbol: 'ALT' },
        uris: { icon: 'ipfs://breakfast.png' },
      },
    });

    expect(normalized).toEqual({
      tokenId:
        'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
      symbol: 'BREAKFAST',
      name: 'Breakfast Token',
      decimals: 2,
      imageUrl: 'ipfs://breakfast.png',
      tvlSats: 0,
    });
  });

  it('normalizes decimals from bcmr well-known metadata when present', () => {
    const normalized = normalizeCauldronTokenRow({
      token_id:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      display_name: 'Moria USD',
      display_symbol: 'MUSD',
      bcmr_well_known: [
        {
          symbol: 'MUSD',
          decimals: 4,
          name: 'Moria USD',
        },
      ],
    });

    expect(normalized).toEqual({
      tokenId:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      symbol: 'MUSD',
      name: 'Moria USD',
      decimals: 4,
      imageUrl: null,
      tvlSats: 0,
    });
  });

  it('builds a signable Cauldron trade request using wallet funding inputs', () => {
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: WITHDRAW_PKH },
      txHash: '11'.repeat(32),
      outputIndex: 0,
      output: {
        amountSatoshis: 1_000_000n,
        tokenCategory:
          'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
        tokenAmount: 1_138_899_210_697n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: WITHDRAW_PKH,
        }),
      },
    };
    const pair = createCauldronPoolPair(
      pool,
      CAULDRON_NATIVE_BCH,
      pool.output.tokenCategory
    );
    const trade = calcCauldronTradeWithTargetDemand(pair, 1_000_000n);
    const built = buildCauldronTradeRequest({
      poolTrades: [
        toCauldronPoolTrade(pool, CAULDRON_NATIVE_BCH, pool.output.tokenCategory, {
          supply: trade?.supply ?? 0n,
          demand: trade?.demand ?? 0n,
          tradeFee: trade?.tradeFee ?? 0n,
        }),
      ],
      walletInputs: [
        {
          utxo: {
            address: TEST_CASHADDR,
            tx_hash: '22'.repeat(32),
            tx_pos: 1,
            value: 200_000,
            amount: 200_000,
            height: 0,
          },
          lockingBytecode: Uint8Array.from([
            0x76, 0xa9, 0x14, 0x4d, 0x7f, 0xca, 0xe5, 0x63, 0xe6, 0x9d,
            0x2f, 0xfa, 0xa3, 0x67, 0xc7, 0xd3, 0xe6, 0x18, 0xa8, 0xae,
            0xd1, 0x25, 0x4c, 0x88, 0xac,
          ]),
          pathName: 'receive',
          addressIndex: 0,
        },
      ],
      recipientAddress: TEST_CASHADDR,
      changeAddress: TEST_CASHADDR,
      feeRateSatsPerByte: 1n,
    });

    expect(built.signRequest.inputPaths).toEqual([[1, 'receive', 0]]);
    const builtTransaction = built.signRequest.transaction.transaction;
    if (typeof builtTransaction === 'string') {
      throw new Error('Expected structured Cauldron transaction payload');
    }
    expect(builtTransaction.inputs).toHaveLength(2);
    expect(builtTransaction.outputs.length >= 2).toBe(true);
    expect(built.estimatedFeeSatoshis > 0n).toBe(true);
  });

  it('can aggregate a target-supply trade across multiple pools', () => {
    const makePool = (txHashSeed: string, sats: bigint, tokens: bigint) => ({
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: WITHDRAW_PKH },
      txHash: txHashSeed.repeat(64).slice(0, 64),
      outputIndex: 0,
      output: {
        amountSatoshis: sats,
        tokenCategory:
          'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
        tokenAmount: tokens,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: WITHDRAW_PKH,
        }),
      },
    });

    const aggregated = planAggregatedTradeForTargetSupply(
      [
        makePool('1', 100_000n, 80_000_000n),
        makePool('2', 100_000n, 80_000_000n),
      ],
      CAULDRON_NATIVE_BCH,
      'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
      150_000n
    );

    expect(aggregated).not.toBeNull();
    expect((aggregated?.trades.length ?? 0) > 1).toBe(true);
    expect((aggregated?.summary.demand ?? 0n) > 0n).toBe(true);
  });

  it('can aggregate a target-demand trade across multiple pools', () => {
    const makePool = (txHashSeed: string, sats: bigint, tokens: bigint) => ({
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: WITHDRAW_PKH },
      txHash: txHashSeed.repeat(64).slice(0, 64),
      outputIndex: 0,
      output: {
        amountSatoshis: sats,
        tokenCategory:
          'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
        tokenAmount: tokens,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: WITHDRAW_PKH,
        }),
      },
    });

    const aggregated = planAggregatedTradeForTargetDemand(
      [
        makePool('3', 80_000n, 120_000_000n),
        makePool('4', 120_000n, 140_000_000n),
      ],
      CAULDRON_NATIVE_BCH,
      'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
      200_000_000n
    );

    expect(aggregated).not.toBeNull();
    expect((aggregated?.trades.length ?? 0) > 1).toBe(true);
    expect((aggregated?.summary.demand ?? 0n) >= 200_000_000n).toBe(true);
    expect((aggregated?.summary.supply ?? 0n) > 0n).toBe(true);
  });

  it('can aggregate a BCH-to-token exact-input trade across multiple pools', () => {
    const tokenId =
      'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63';
    const makePool = (txHashSeed: string, sats: bigint, tokens: bigint) => ({
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: WITHDRAW_PKH },
      txHash: txHashSeed.repeat(64).slice(0, 64),
      outputIndex: 0,
      output: {
        amountSatoshis: sats,
        tokenCategory: tokenId,
        tokenAmount: tokens,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: WITHDRAW_PKH,
        }),
      },
    });

    const aggregated = planAggregatedTradeForTargetSupply(
      [
        makePool('5', 80_000n, 120_000_000n),
        makePool('6', 120_000n, 140_000_000n),
      ],
      CAULDRON_NATIVE_BCH,
      tokenId,
      10_000n
    );

    expect(aggregated).not.toBeNull();
    expect(aggregated?.trades.length ?? 0).toBeGreaterThan(0);
    expect((aggregated?.summary.supply ?? 0n) >= 10_000n).toBe(true);
    expect((aggregated?.summary.demand ?? 0n) > 0n).toBe(true);
  });

  it('analyzes executable liquidity in both directions for a token market', () => {
    const tokenId =
      'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63';
    const makePool = (txHashSeed: string, sats: bigint, tokens: bigint) => ({
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: WITHDRAW_PKH },
      txHash: txHashSeed.repeat(64).slice(0, 64),
      outputIndex: 0,
      output: {
        amountSatoshis: sats,
        tokenCategory: tokenId,
        tokenAmount: tokens,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: WITHDRAW_PKH,
        }),
      },
    });

    const liquidity = analyzeCauldronMarketLiquidity(
      [
        makePool('1', 1_118_498_378n, 11n),
        makePool('2', 2_000_000_000n, 20n),
      ],
      tokenId
    );

    expect(liquidity.bchToToken.executablePoolCount).toBe(2);
    expect(liquidity.bchToToken.maxDemand).toBeGreaterThan(0n);
    expect(liquidity.tokenToBch.executablePoolCount).toBe(2);
    expect(liquidity.tokenToBch.maxSupply).toBeGreaterThan(0n);
    expect(liquidity.tokenToBch.maxDemand).toBeGreaterThan(0n);
  });

  it('plans a token-to-BCH direct route for a small executable amount', () => {
    const tokenId =
      'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63';
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: WITHDRAW_PKH },
      txHash: '5a'.repeat(32),
      outputIndex: 0,
      output: {
        amountSatoshis: 1_118_498_378n,
        tokenCategory: tokenId,
        tokenAmount: 11n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: WITHDRAW_PKH,
        }),
      },
    };
    const pair = createCauldronPoolPair(pool, tokenId, CAULDRON_NATIVE_BCH);
    const trade = calcCauldronTradeWithTargetSupply(pair, 2n);

    expect(trade).not.toBeNull();
    expect(trade?.demand).toBeGreaterThan(0n);
    expect(trade?.supply).toBe(2n);
  });

  it('accepts the smallest token-to-BCH exact-input amount that remains executable', () => {
    const tokenId =
      'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63';
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: WITHDRAW_PKH },
      txHash: '5b'.repeat(32),
      outputIndex: 0,
      output: {
        amountSatoshis: 1_118_498_378n,
        tokenCategory: tokenId,
        tokenAmount: 11n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: WITHDRAW_PKH,
        }),
      },
    };
    const pair = createCauldronPoolPair(pool, tokenId, CAULDRON_NATIVE_BCH);

    expect(calcCauldronTradeWithTargetSupply(pair, 0n)).toBeNull();
    expect(calcCauldronTradeWithTargetSupply(pair, 1n)).not.toBeNull();
  });

  it('plans a BCH-to-token exact-input trade for a live-style pool shape', () => {
    const tokenId =
      '3eecc5b229164ab65aee6c02f05eca50ae604d97c691593f52922bdaa5e8d195';
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: WITHDRAW_PKH },
      txHash: '6a'.repeat(32),
      outputIndex: 0,
      output: {
        amountSatoshis: 215_539_243n,
        tokenCategory: tokenId,
        tokenAmount: 92_820n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: WITHDRAW_PKH,
        }),
      },
    };
    const pair = createCauldronPoolPair(pool, CAULDRON_NATIVE_BCH, tokenId);
    const trade = calcCauldronTradeWithTargetSupply(pair, 1_000_000n);

    expect(trade).not.toBeNull();
    expect(trade?.supply).toBe(1_000_000n);
    expect(trade?.demand).toBeGreaterThan(0n);
  });

  it('builds a signed swap transaction that passes the Cauldron VM checks', () => {
    const sampleTokenId =
      '412064756d6d7920746f6b656e2069642c203132332031323320313233212121';
    const zeroWithdrawPkh = new Uint8Array(20);
    const makePool = (index: number, tokenAmount: bigint, amountSatoshis: bigint) => ({
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: zeroWithdrawPkh },
      txHash: '41'.repeat(32),
      outputIndex: index,
      output: {
        amountSatoshis,
        tokenCategory: sampleTokenId,
        tokenAmount,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: zeroWithdrawPkh,
        }),
      },
    });

    const pool0 = makePool(0, 11n, 1_122_751_507n);
    const pool1 = makePool(1, 20n, 1_122_751_507n);
    const walletInput = createWalletInputFixture({
      value: 14n * 100_000_000n,
    });

    const built = buildCauldronTradeRequest({
      poolTrades: [
        toCauldronPoolTrade(pool0, CAULDRON_NATIVE_BCH, sampleTokenId, {
          supply: 422_298_712n,
          demand: 3n,
          tradeFee: 1_266_896n,
        }),
        toCauldronPoolTrade(pool1, CAULDRON_NATIVE_BCH, sampleTokenId, {
          supply: 921_379_007n,
          demand: 9n,
          tradeFee: 2_764_137n,
        }),
      ],
      walletInputs: [walletInput],
      recipientAddress: TEST_CASHADDR,
      changeAddress: TEST_CASHADDR,
      feeRateSatsPerByte: 1n,
    });

    const signed = signRequestForTest({
      signRequest: built.signRequest as any,
      keyByInputIndex: new Map([[2, TEST_PRIVATE_KEY]]),
    });

    expectVmAccepts(signed);
    expect(signed.transaction.outputs[0]?.valueSatoshis).toBe(1_545_050_219n);
    expect(signed.transaction.outputs[1]?.valueSatoshis).toBe(2_044_130_514n);
    expect(signed.transaction.outputs[2]?.token?.amount).toBe(12n);
  });

  it('builds a signed token-to-BCH swap transaction that passes the Cauldron VM checks', () => {
    const sampleTokenId =
      '412064756d6d7920746f6b656e2069642c203132332031323320313233212121';
    const zeroWithdrawPkh = new Uint8Array(20);
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: zeroWithdrawPkh },
      txHash: '42'.repeat(32),
      outputIndex: 0,
      output: {
        amountSatoshis: 1_118_498_378n,
        tokenCategory: sampleTokenId,
        tokenAmount: 11n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: zeroWithdrawPkh,
        }),
      },
    };
    const walletInput = createWalletInputFixture({
      txHash: '52'.repeat(32),
      txPos: 1,
      value: 800n,
      token: {
        category: sampleTokenId,
        amount: 3n,
      },
    });
    const bchFundingInput = createWalletInputFixture({
      txHash: '53'.repeat(32),
      txPos: 2,
      value: 100_000_000n,
    });

    const built = buildCauldronTradeRequest({
      poolTrades: [
        toCauldronPoolTrade(pool, sampleTokenId, CAULDRON_NATIVE_BCH, {
          supply: 2n,
          demand: 171_561_988n,
          tradeFee: 514_685n,
        }),
      ],
      walletInputs: [walletInput, bchFundingInput],
      recipientAddress: TEST_CASHADDR,
      changeAddress: TEST_CASHADDR,
      tokenChangeAddress: TEST_CASHADDR,
      feeRateSatsPerByte: 1n,
    });

    const signed = signRequestForTest({
      signRequest: built.signRequest as any,
      keyByInputIndex: new Map([
        [1, TEST_PRIVATE_KEY],
        [2, TEST_PRIVATE_KEY],
      ]),
    });

    expectVmAccepts(signed);
    expect(signed.transaction.outputs[0]?.valueSatoshis).toBe(946_936_390n);
    expect(signed.transaction.outputs[0]?.token?.amount).toBe(13n);
  });

  it('keeps token-to-BCH swap fee estimates high enough for the signed transaction size', () => {
    const sampleTokenId =
      '412064756d6d7920746f6b656e2069642c203132332031323320313233212121';
    const zeroWithdrawPkh = new Uint8Array(20);
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: zeroWithdrawPkh },
      txHash: '42'.repeat(32),
      outputIndex: 0,
      output: {
        amountSatoshis: 1_118_498_378n,
        tokenCategory: sampleTokenId,
        tokenAmount: 11n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: zeroWithdrawPkh,
        }),
      },
    };
    const tokenFundingInput = createWalletInputFixture({
      txHash: '52'.repeat(32),
      txPos: 1,
      value: 800n,
      token: {
        category: sampleTokenId,
        amount: 3n,
      },
    });
    const bchFundingInput = createWalletInputFixture({
      txHash: '53'.repeat(32),
      txPos: 2,
      value: 100_000_000n,
    });

    const built = buildCauldronTradeRequest({
      poolTrades: [
        toCauldronPoolTrade(pool, sampleTokenId, CAULDRON_NATIVE_BCH, {
          supply: 2n,
          demand: 171_561_988n,
          tradeFee: 514_685n,
        }),
      ],
      walletInputs: [tokenFundingInput, bchFundingInput],
      recipientAddress: TEST_CASHADDR,
      changeAddress: TEST_CASHADDR,
      tokenChangeAddress: TEST_CASHADDR,
      feeRateSatsPerByte: 1n,
    });

    const signed = signRequestForTest({
      signRequest: built.signRequest as any,
      keyByInputIndex: new Map([
        [1, TEST_PRIVATE_KEY],
        [2, TEST_PRIVATE_KEY],
      ]),
    });
    const signedHex = binToHex(encodeTransaction(signed.transaction));

    expect(() =>
      assertSignedTransactionFeeSufficiency({
        signedTransactionHex: signedHex,
        sourceOutputs: built.sourceOutputs,
        estimatedFeeSatoshis: built.estimatedFeeSatoshis,
        transactionLabel: 'Cauldron swap',
      })
    ).not.toThrow();
  });

  it('measures the actual fee paid by a signed Cauldron transaction', () => {
    const sampleTokenId =
      '412064756d6d7920746f6b656e2069642c203132332031323320313233212121';
    const zeroWithdrawPkh = new Uint8Array(20);
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: zeroWithdrawPkh },
      txHash: '41'.repeat(32),
      outputIndex: 0,
      output: {
        amountSatoshis: 1_122_751_507n,
        tokenCategory: sampleTokenId,
        tokenAmount: 11n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: zeroWithdrawPkh,
        }),
      },
    };
    const walletInput = createWalletInputFixture({
      value: 14n * 100_000_000n,
    });

    const built = buildCauldronTradeRequest({
      poolTrades: [
        toCauldronPoolTrade(pool, CAULDRON_NATIVE_BCH, sampleTokenId, {
          supply: 422_298_712n,
          demand: 3n,
          tradeFee: 1_266_896n,
        }),
      ],
      walletInputs: [walletInput],
      recipientAddress: TEST_CASHADDR,
      changeAddress: TEST_CASHADDR,
      feeRateSatsPerByte: 1n,
    });

    const signed = signRequestForTest({
      signRequest: built.signRequest as any,
      keyByInputIndex: new Map([[1, TEST_PRIVATE_KEY]]),
    });
    const signedHex = binToHex(encodeTransaction(signed.transaction));
    const { actualFeeSatoshis, transactionSizeBytes } =
      calculateSignedTransactionFeeSatoshis(signedHex, built.sourceOutputs);

    expect(actualFeeSatoshis).toBeGreaterThan(0n);
    expect(transactionSizeBytes).toBeGreaterThan(0n);
    expect(actualFeeSatoshis).toBeGreaterThanOrEqual(built.estimatedFeeSatoshis);
  });

  it('rejects a signed Cauldron transaction before broadcast if it violates covenant rules', () => {
    const sampleTokenId =
      '412064756d6d7920746f6b656e2069642c203132332031323320313233212121';
    const zeroWithdrawPkh = new Uint8Array(20);
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: zeroWithdrawPkh },
      txHash: '41'.repeat(32),
      outputIndex: 0,
      output: {
        amountSatoshis: 1_122_751_507n,
        tokenCategory: sampleTokenId,
        tokenAmount: 11n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: zeroWithdrawPkh,
        }),
      },
    };
    const walletInput = createWalletInputFixture({
      value: 14n * 100_000_000n,
    });

    const built = buildCauldronTradeRequest({
      poolTrades: [
        toCauldronPoolTrade(pool, CAULDRON_NATIVE_BCH, sampleTokenId, {
          supply: 422_298_712n,
          demand: 3n,
          tradeFee: 1_266_896n,
        }),
      ],
      walletInputs: [walletInput],
      recipientAddress: TEST_CASHADDR,
      changeAddress: TEST_CASHADDR,
      feeRateSatsPerByte: 1n,
    });

    const signed = signRequestForTest({
      signRequest: built.signRequest as any,
      keyByInputIndex: new Map([[1, TEST_PRIVATE_KEY]]),
    });
    signed.transaction.outputs[0] = {
      ...signed.transaction.outputs[0]!,
      valueSatoshis: signed.transaction.outputs[0]!.valueSatoshis - 1n,
    };
    const signedHex = binToHex(encodeTransaction(signed.transaction));

    expect(() =>
      assertSignedTransactionCovenantValidity({
        signedTransactionHex: signedHex,
        sourceOutputs: built.sourceOutputs,
        transactionLabel: 'Cauldron swap',
      })
    ).toThrow('Cauldron swap does not satisfy the on-chain covenant rules');
    expect(() =>
      assertSignedTransactionCovenantValidity({
        signedTransactionHex: signedHex,
        sourceOutputs: built.sourceOutputs,
        transactionLabel: 'Cauldron swap',
      })
    ).toThrow(`${pool.txHash}:${pool.outputIndex}`);
  });

  it('rejects a signed Cauldron transaction if the actual fee falls below the required amount', () => {
    const sampleTokenId =
      '412064756d6d7920746f6b656e2069642c203132332031323320313233212121';
    const zeroWithdrawPkh = new Uint8Array(20);
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash: zeroWithdrawPkh },
      txHash: '41'.repeat(32),
      outputIndex: 0,
      output: {
        amountSatoshis: 1_122_751_507n,
        tokenCategory: sampleTokenId,
        tokenAmount: 11n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash: zeroWithdrawPkh,
        }),
      },
    };
    const walletInput = createWalletInputFixture({
      value: 14n * 100_000_000n,
    });

    const built = buildCauldronTradeRequest({
      poolTrades: [
        toCauldronPoolTrade(pool, CAULDRON_NATIVE_BCH, sampleTokenId, {
          supply: 422_298_712n,
          demand: 3n,
          tradeFee: 1_266_896n,
        }),
      ],
      walletInputs: [walletInput],
      recipientAddress: TEST_CASHADDR,
      changeAddress: TEST_CASHADDR,
      feeRateSatsPerByte: 1n,
    });

    const signed = signRequestForTest({
      signRequest: built.signRequest as any,
      keyByInputIndex: new Map([[1, TEST_PRIVATE_KEY]]),
    });
    const signedHex = binToHex(encodeTransaction(signed.transaction));
    const { actualFeeSatoshis } = calculateSignedTransactionFeeSatoshis(
      signedHex,
      built.sourceOutputs
    );

    expect(() =>
      assertSignedTransactionFeeSufficiency({
        signedTransactionHex: signedHex,
        sourceOutputs: built.sourceOutputs,
        estimatedFeeSatoshis: actualFeeSatoshis + 1n,
        transactionLabel: 'Cauldron swap',
      })
    ).toThrow(
      'Cauldron swap fee is too low after signing.'
    );
  });

  it('builds a mocknet-backed Cauldron pool deposit transaction with deterministic outputs', async () => {
    const provider = new MockNetworkProvider();
    const ownerLockingBytecode = privateKeyToP2pkhLockingBytecode({
      privateKey: TEST_PRIVATE_KEY,
      throwErrors: true,
    });
    const ownerAddressResult = lockingBytecodeToCashAddress({
      prefix: 'bchtest',
      bytecode: ownerLockingBytecode,
    });
    if (typeof ownerAddressResult === 'string') {
      throw new Error(ownerAddressResult);
    }
    const ownerAddress = toCashAddress(ownerAddressResult);

    const tokenId =
      'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63';
    provider.reset();
    provider.addUtxo(ownerAddress, {
      txid: '33'.repeat(32),
      vout: 0,
      satoshis: 5_000n,
      token: {
        category: tokenId,
        amount: 5_000n,
      },
    });
    provider.addUtxo(ownerAddress, {
      txid: '44'.repeat(32),
      vout: 1,
      satoshis: 2_000_000n,
    });

    const ownerUtxos = await provider.getUtxos(ownerAddress);
    const walletInputs = ownerUtxos.map((utxo, index) => ({
      utxo: {
        address: ownerAddress,
        tx_hash: utxo.txid,
        tx_pos: utxo.vout,
        value: Number(utxo.satoshis),
        amount: Number(utxo.satoshis),
        height: 0,
        token: utxo.token
          ? {
              category: utxo.token.category,
              amount: utxo.token.amount,
            }
          : null,
      },
      lockingBytecode: ownerLockingBytecode,
      pathName: 'receive' as const,
      addressIndex: index,
    }));

    const withdrawPublicKeyHash = hash160(
      secp256k1.derivePublicKeyCompressed(TEST_PRIVATE_KEY) as Uint8Array
    );
    const built = buildCauldronPoolDepositRequest({
      walletInputs,
      withdrawPublicKeyHash,
      tokenCategoryHex: tokenId,
      tokenAmount: 4_000n,
      bchAmountSatoshis: 1_500_000n,
      ownerAddress,
      changeAddress: ownerAddress,
      feeRateSatsPerByte: 1n,
    });

    const signed = signRequestForTest({
      signRequest: built.signRequest as any,
      keyByInputIndex: new Map([
        [0, TEST_PRIVATE_KEY],
        [1, TEST_PRIVATE_KEY],
      ]),
    });

    const poolLockingBytecode = buildCauldronPoolV0LockingBytecode({
      withdrawPublicKeyHash,
    });
    expect(binToHex(signed.transaction.outputs[0]?.lockingBytecode as Uint8Array)).toBe(
      binToHex(poolLockingBytecode)
    );
    expect(signed.transaction.outputs[0]?.valueSatoshis).toBe(1_500_000n);
    expect(signed.transaction.outputs[0]?.token?.amount).toBe(4_000n);
  });

  it('builds a signed Cauldron pool withdraw transaction that passes the VM checks', () => {
    const ownerLockingBytecode = privateKeyToP2pkhLockingBytecode({
      privateKey: TEST_PRIVATE_KEY,
      throwErrors: true,
    });
    const ownerAddressResult = lockingBytecodeToCashAddress({
      prefix: 'bitcoincash',
      bytecode: ownerLockingBytecode,
    });
    if (typeof ownerAddressResult === 'string') {
      throw new Error(ownerAddressResult);
    }
    const ownerAddress = toCashAddress(ownerAddressResult);

    const withdrawPublicKeyHash = hash160(
      secp256k1.derivePublicKeyCompressed(TEST_PRIVATE_KEY) as Uint8Array
    );
    const tokenId =
      'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63';
    const pool = {
      version: '0' as const,
      parameters: { withdrawPublicKeyHash },
      txHash: '55'.repeat(32),
      outputIndex: 0,
      output: {
        amountSatoshis: 1_600_000n,
        tokenCategory: tokenId,
        tokenAmount: 4_000n,
        lockingBytecode: buildCauldronPoolV0LockingBytecode({
          withdrawPublicKeyHash,
        }),
      },
    };
    const ownerInput = createWalletInputFixture({
      address: ownerAddress,
      txHash: '66'.repeat(32),
      txPos: 1,
      value: 546n,
    });

    const built = buildCauldronPoolWithdrawRequest({
      pool,
      ownerInput,
      recipientAddress: ownerAddress,
      feeRateSatsPerByte: 1n,
    });

    const signed = signRequestForTest({
      signRequest: built.signRequest as any,
      keyByInputIndex: new Map([
        [0, TEST_PRIVATE_KEY],
        [1, TEST_PRIVATE_KEY],
      ]),
    });

    expectVmAccepts(signed);
    expect(signed.transaction.outputs[0]?.token?.amount).toBe(4_000n);
    expect(signed.transaction.outputs[0]?.valueSatoshis).toBeGreaterThanOrEqual(1_000n);
  });

  it('detects wallet pool positions and matching token NFTs', () => {
    const normalized = normalizeCauldronPoolRow({
      txid: 'ef'.repeat(32),
      tx_pos: 2,
      sats: 1000000,
      token_id:
        'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
      tokens: 1138899210697,
      withdraw_pubkey_hash:
        'b034dc7821b2b25c38b5825cdc4af9e6ace02be7',
      owner_pkh: '76a04053bda0a88bda5177b86a15c3b29f559873',
      owner_p2pkh_addr: TEST_CASHADDR,
      pool_id: 'aa'.repeat(32),
    });

    const positions = detectCauldronWalletPoolPositions(
      [normalized as NonNullable<typeof normalized>],
      [
        {
          address: TEST_CASHADDR,
          tx_hash: '11'.repeat(32),
          tx_pos: 0,
          value: 1000,
          height: 1,
          token: {
            category:
              'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
            amount: 1n,
            nft: {
              capability: 'none',
              commitment: 'abcd',
            },
          },
        },
      ]
    );

    expect(positions).toHaveLength(1);
    expect(positions[0]?.ownerAddress).toBe(TEST_CASHADDR);
    expect(positions[0]?.hasMatchingTokenNft).toBe(true);
    expect(positions[0]?.matchingNftUtxos).toHaveLength(1);
    expect(positions[0]?.detectionSource).toBe('token_nft_hint');
  });

  it('prefers pool NFT commitment matches when available', () => {
    const normalized = normalizeCauldronPoolRow({
      txid: 'ef'.repeat(32),
      tx_pos: 2,
      sats: 1000000,
      token_id:
        'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
      tokens: 1138899210697,
      withdraw_pubkey_hash:
        'b034dc7821b2b25c38b5825cdc4af9e6ace02be7',
      pool_id: 'aa'.repeat(32),
    });

    const positions = detectCauldronWalletPoolPositions(
      [normalized as NonNullable<typeof normalized>],
      [
        {
          address: TEST_CASHADDR,
          tx_hash: '11'.repeat(32),
          tx_pos: 0,
          value: 1000,
          height: 1,
          token: {
            category:
              'f6677f3d3805d70949b375d36e094ff0ec9ece2a2cb1fde6d8b0e90b368f1f63',
            amount: 1n,
            nft: {
              capability: 'none',
              commitment: 'aa'.repeat(32),
            },
          },
        },
      ]
    );

    expect(positions[0]?.detectionSource).toBe('pool_nft_commitment');
  });
});
