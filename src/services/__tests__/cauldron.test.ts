import { describe, expect, it } from 'vitest';

import {
  CAULDRON_NATIVE_BCH,
  buildCauldronPoolV0ExchangeUnlockingBytecode,
  buildCauldronPoolV0LockingBytecode,
  buildCauldronPoolV0RedeemScript,
  buildCauldronTradeRequest,
  calcCauldronPairRate,
  calcCauldronTradeFee,
  calcCauldronTradeWithTargetDemand,
  createCauldronPoolPair,
  extractCauldronPoolV0ParametersFromUnlockingBytecode,
  formatPoolOutpoint,
  getCauldronPoolV0WithdrawPublicKeyHash,
  normalizeCauldronPoolRow,
  normalizeCauldronTokenRow,
  detectCauldronWalletPoolPositions,
  planAggregatedTradeForTargetSupply,
  planBestSinglePoolTradeForTargetDemand,
  toCauldronPoolTrade,
  tryParseCauldronPoolFromUtxo,
} from '../cauldron';

const WITHDRAW_PKH = Uint8Array.from([
  0xb0, 0x34, 0xdc, 0x78, 0x21, 0xb2, 0xb2, 0x5c, 0x38, 0xb5,
  0x82, 0x5c, 0xdc, 0x4a, 0xf9, 0xe6, 0xac, 0xe0, 0x2b, 0xe7,
]);
const TEST_CASHADDR =
  'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';

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
