import { cashAddressToLockingBytecode } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';

import { Network } from '../../state/slices/networkSlice';
import {
  CAULDRON_NATIVE_BCH,
  CauldronApiClient,
  analyzeCauldronMarketLiquidity,
  buildCauldronTradeRequest,
  fetchNormalizedCauldronPools,
  fetchNormalizedCauldronUserPools,
  normalizeCauldronTokenRow,
  type CauldronPool,
  planAggregatedTradeForTargetSupply,
} from '../cauldron';

const RUN_LIVE_CAULDRON = process.env.RUN_CAULDRON_LIVE === '1';
const liveDescribe = RUN_LIVE_CAULDRON ? describe : describe.skip;

const TEST_CASHADDR = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';

function makeBchFundingInput(valueSatoshis: bigint) {
  const result = cashAddressToLockingBytecode(TEST_CASHADDR);
  if (typeof result === 'string') {
    throw new Error(`Unable to build live-smoke funding input: ${result}`);
  }

  const value = Number(valueSatoshis);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Live-smoke funding input does not fit a safe integer: ${valueSatoshis}`
    );
  }

  return {
    utxo: {
      address: TEST_CASHADDR,
      tx_hash: '33'.repeat(32),
      tx_pos: 0,
      value,
      amount: value,
      height: 0,
      token: null,
    },
    lockingBytecode: result.bytecode,
    pathName: 'receive' as const,
    addressIndex: 0,
  };
}

async function loadLiveMarket(network: Network): Promise<{
  client: CauldronApiClient;
  tokenId: string;
  rows: Awaited<ReturnType<CauldronApiClient['listActivePools']>>;
  pools: CauldronPool[];
}> {
  const client = new CauldronApiClient(network);
  const tokens = await client.listCachedTokens({
    limit: 5,
    offset: 0,
    by: 'score',
    order: 'desc',
  });

  for (const token of tokens) {
    const tokenId =
      normalizeCauldronTokenRow(token)?.tokenId ??
      (typeof (token as Record<string, unknown>).token_id === 'string'
        ? ((token as Record<string, unknown>).token_id as string)
            .trim()
            .toLowerCase()
        : '');
    if (!tokenId) continue;

    const [rows, pools] = await Promise.all([
      client.listActivePools({ tokenId }),
      fetchNormalizedCauldronPools(network, client, tokenId),
    ]);

    if (pools.length > 0) {
      return {
        client,
        tokenId,
        rows,
        pools,
      };
    }
  }

  throw new Error(`No live Cauldron pools found on ${network}`);
}

liveDescribe('cauldron live indexer smoke', () => {
  it('fetches, normalizes, and plans against live Riften pool data', async () => {
    const markets = await Promise.all([
      loadLiveMarket(Network.MAINNET),
      loadLiveMarket(Network.CHIPNET),
    ]);

    for (const market of markets) {
      expect(market.rows.length).toBeGreaterThan(0);
      expect(market.pools.length).toBeGreaterThan(0);

      const firstRow = market.rows[0];
      const ownerPkh =
        typeof firstRow?.owner_pkh === 'string'
          ? firstRow.owner_pkh.trim().toLowerCase()
          : '';
      const ownerAddress =
        typeof firstRow?.owner_p2pkh_addr === 'string'
          ? firstRow.owner_p2pkh_addr.trim()
          : '';

      expect(ownerPkh).toMatch(/^[0-9a-f]{40}$/);
      expect(ownerAddress).toMatch(/^bitcoincash:/i);

      const userPools = await fetchNormalizedCauldronUserPools(
        market.client.network,
        [{ address: ownerAddress }],
        market.client
      );
      expect(userPools.some((pool) => pool.poolId === firstRow?.pool_id)).toBe(
        true
      );

      const liquidity = analyzeCauldronMarketLiquidity(
        market.pools,
        market.tokenId
      );
      expect(liquidity.bchToToken.executablePoolCount).toBeGreaterThan(0);
      expect(liquidity.tokenToBch.executablePoolCount).toBeGreaterThan(0);

      const targetSupply = market.pools[0]!.output.amountSatoshis / 100n || 1n;
      const tradePlan = planAggregatedTradeForTargetSupply(
        market.pools,
        CAULDRON_NATIVE_BCH,
        market.tokenId,
        targetSupply
      );
      expect(tradePlan).not.toBeNull();
      if (!tradePlan) {
        throw new Error(
          `Unable to plan a live Cauldron trade on ${market.client.network}`
        );
      }

      const built = buildCauldronTradeRequest({
        poolTrades: tradePlan.trades,
        walletInputs: [makeBchFundingInput(targetSupply + 10_000_000n)],
        recipientAddress: TEST_CASHADDR,
        changeAddress: TEST_CASHADDR,
        feeRateSatsPerByte: 1n,
      });

      expect(built.sourceOutputs).toHaveLength(tradePlan.trades.length + 1);
      const builtTransaction = built.signRequest.transaction.transaction;
      if (typeof builtTransaction === 'string') {
        throw new Error('Expected a structured Cauldron transaction payload');
      }
      expect(builtTransaction.inputs).toHaveLength(tradePlan.trades.length + 1);
      expect(built.estimatedFeeSatoshis).toBeGreaterThan(0n);
      expect(built.totalSupply).toBe(tradePlan.summary.supply);
    }
  }, 30_000);
});
