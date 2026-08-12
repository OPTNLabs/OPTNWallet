import { cashAddressToLockingBytecode } from '@bitauth/libauth';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CAULDRON_NATIVE_BCH,
  analyzeCauldronMarketLiquidity,
  buildCauldronTradeRequest,
  normalizeCauldronPoolRow,
  normalizeCauldronTokenRow,
  planAggregatedTradeForTargetSupply,
  type CauldronPool,
} from '../cauldron';

type LiveSnapshot = {
  generatedAt: string;
  source: string;
  networks: Array<{
    network: 'mainnet' | 'chipnet';
    apiBase: string;
    topTokens: Array<Record<string, unknown>>;
    market: {
      tokenId: string;
      tokenRow: Record<string, unknown>;
      activePoolRows: Array<Record<string, unknown>>;
    };
  }>;
};

const snapshotPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/cauldron-live-snapshot.json'
);
const snapshot = JSON.parse(
  readFileSync(snapshotPath, 'utf8')
) as LiveSnapshot;

const TEST_CASHADDR = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';

function makeBchFundingInput(valueSatoshis: bigint) {
  const result = cashAddressToLockingBytecode(TEST_CASHADDR);
  if (typeof result === 'string') {
    throw new Error(`Unable to build live snapshot funding input: ${result}`);
  }

  const value = Number(valueSatoshis);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Live snapshot funding input does not fit a safe integer: ${valueSatoshis}`
    );
  }

  return {
    utxo: {
      address: TEST_CASHADDR,
      tx_hash: '44'.repeat(32),
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

describe('cauldron live snapshot fixture', () => {
  it('covers real indexer payloads without requiring a live fetch', () => {
    expect(snapshot.networks.length).toBeGreaterThan(0);

    for (const network of snapshot.networks) {
      expect(network.topTokens.length).toBeGreaterThan(0);
      expect(network.market.activePoolRows.length).toBeGreaterThan(0);

      const normalizedToken = normalizeCauldronTokenRow(network.market.tokenRow);
      expect(normalizedToken?.tokenId).toBe(network.market.tokenId);

      const pools = network.market.activePoolRows
        .map((row) => normalizeCauldronPoolRow(row))
        .filter((pool): pool is CauldronPool => pool !== null);
      expect(pools.length).toBeGreaterThan(0);

      const liquidity = analyzeCauldronMarketLiquidity(pools, network.market.tokenId);
      expect(liquidity.bchToToken.executablePoolCount).toBeGreaterThan(0);
      expect(liquidity.tokenToBch.executablePoolCount).toBeGreaterThan(0);

      const targetSupplyCandidates = Array.from(
        new Set([
          1n,
          10n,
          100n,
          1_000n,
          10_000n,
          100_000n,
          liquidity.bchToToken.maxSupply,
          liquidity.bchToToken.maxSupply / 2n,
          liquidity.bchToToken.maxSupply / 4n,
          liquidity.bchToToken.maxSupply / 8n,
          liquidity.bchToToken.maxSupply / 16n,
          liquidity.bchToToken.maxSupply / 32n,
          pools[0]!.output.amountSatoshis / 2n,
          pools[0]!.output.amountSatoshis / 4n,
          pools[0]!.output.amountSatoshis / 8n,
          pools[0]!.output.amountSatoshis / 16n,
        ])
      ).filter((candidate) => candidate > 0n);

      let plan: ReturnType<typeof planAggregatedTradeForTargetSupply> = null;
      for (const targetSupply of targetSupplyCandidates) {
        plan = planAggregatedTradeForTargetSupply(
          pools,
          CAULDRON_NATIVE_BCH,
          network.market.tokenId,
          targetSupply
        );
        if (plan) break;
      }

      expect(plan).not.toBeNull();
      if (!plan) {
        throw new Error(
          `Unable to plan a live snapshot trade on ${network.network}; liquidity=${JSON.stringify(
            {
              bchToToken: {
                executablePoolCount: liquidity.bchToToken.executablePoolCount,
                maxSupply: liquidity.bchToToken.maxSupply.toString(),
                maxDemand: liquidity.bchToToken.maxDemand.toString(),
              },
              tokenToBch: {
                executablePoolCount: liquidity.tokenToBch.executablePoolCount,
                maxSupply: liquidity.tokenToBch.maxSupply.toString(),
                maxDemand: liquidity.tokenToBch.maxDemand.toString(),
              },
            }
          )}`
        );
      }

      const built = buildCauldronTradeRequest({
        poolTrades: plan.trades,
        walletInputs: [makeBchFundingInput(plan.summary.supply + 10_000_000n)],
        recipientAddress: TEST_CASHADDR,
        changeAddress: TEST_CASHADDR,
        feeRateSatsPerByte: 1n,
      });

      expect(built.sourceOutputs).toHaveLength(plan.trades.length + 1);
      expect(built.totalSupply).toBe(plan.summary.supply);
      expect(built.totalDemand).toBe(plan.summary.demand);
    }
  });
});
