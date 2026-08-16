/**
 * Pre-fusion consolidate: if one address has more than 3 plain BCH coins,
 * sweep those coins to a fresh receive address so CashFusion sees a clean
 * 1-coin bucket (Electron Cash's intended hygiene). Token coins stay put.
 */

import KeyService from '../../services/KeyService';
import TransactionService from '../../services/TransactionService';
import type { UTXO } from '../../types/types';
import { Network } from '../../state/slices/networkSlice';
import { store } from '../../state/store';
import { createSimpleSendPlanner } from '../../hooks/simple-send/planner';
import {
  EC_SERVER_FUSION_MAX_COINS_PER_ADDRESS,
  findCrowdedPlainAddressBuckets,
  type ServerFusionAddressBucket,
} from './serverFusionCoinPolicy';

export type FusionPreConsolidateResult =
  | { ok: true; txid: string; fromAddress: string; toAddress: string; coinCount: number }
  | { ok: false; reason: string; skipped?: boolean };

function cashPrefix(network: Network): 'bitcoincash:' | 'bchtest:' {
  return network === Network.MAINNET ? 'bitcoincash:' : 'bchtest:';
}

export function walletCanPreConsolidate(): boolean {
  const walletType = store.getState().wallet_id.walletType;
  return walletType !== 'watch-only' && walletType !== 'hardware';
}

export async function allocateFreshReceiveAddress(
  walletId: number,
  network: Network
): Promise<string> {
  const expectedPrefix = cashPrefix(network);
  const keys = await KeyService.retrieveKeys(walletId);
  const occupied = new Set(
    keys
      .filter(
        (key) =>
          Number(key.accountIndex) === 0 && Number(key.changeIndex) === 0
      )
      .map((key) => Number(key.addressIndex))
      .filter((index) => Number.isSafeInteger(index) && index >= 0)
  );
  let cursor = 0;
  for (const index of occupied) cursor = Math.max(cursor, index + 1);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    while (occupied.has(cursor)) cursor += 1;
    const addressIndex = cursor;
    try {
      await KeyService.createKeys(walletId, 0, 0, addressIndex);
      const persisted = await KeyService.retrieveKeys(walletId);
      const row = persisted.find(
        (key) =>
          Number(key.accountIndex) === 0 &&
          Number(key.changeIndex) === 0 &&
          Number(key.addressIndex) === addressIndex
      );
      if (!row?.address) {
        throw new Error(`fresh receive address ${addressIndex} was not persisted`);
      }
      if (!row.address.toLowerCase().startsWith(expectedPrefix)) {
        throw new Error('fresh receive address network does not match the wallet');
      }
      return row.address;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE constraint failed|already exists/i.test(message)) {
        occupied.add(addressIndex);
        cursor = addressIndex + 1;
        continue;
      }
      throw error instanceof Error ? error : new Error(message);
    }
  }
  throw new Error('could not allocate a fresh receive address for consolidate');
}

export async function consolidateCrowdedFusionAddress(options: {
  walletId: number;
  network: Network;
  coins: readonly UTXO[];
  signal?: AbortSignal;
}): Promise<FusionPreConsolidateResult> {
  if (options.signal?.aborted) {
    return { ok: false, reason: 'fusion round cancelled' };
  }
  if (!walletCanPreConsolidate()) {
    return {
      ok: false,
      skipped: true,
      reason: 'watch-only and hardware wallets skip pre-fusion consolidate',
    };
  }

  const crowded = findCrowdedPlainAddressBuckets(options.coins);
  const bucket: ServerFusionAddressBucket | undefined = crowded[0];
  if (!bucket || bucket.coins.length <= EC_SERVER_FUSION_MAX_COINS_PER_ADDRESS) {
    return { ok: false, skipped: true, reason: 'no crowded address' };
  }

  const toAddress = await allocateFreshReceiveAddress(
    options.walletId,
    options.network
  );
  const planner = createSimpleSendPlanner({
    recipient: toAddress,
    selectedCategory: '',
    amountToken: '',
    tokenChangeAddress: toAddress,
    selectedChangeAddress: toAddress,
    dbUtxos: bucket.coins,
  });
  const built = await planner.sweepAllBchUntilBuild(
    Math.min(50, bucket.coins.length)
  );
  if (!built.ok || !built.rawTx) {
    return {
      ok: false,
      reason:
        'err' in built
          ? built.err
          : 'could not build the pre-fusion consolidate transaction',
    };
  }
  if (options.signal?.aborted) {
    return { ok: false, reason: 'fusion round cancelled' };
  }

  const sent = await TransactionService.sendTransaction(
    built.rawTx,
    built.inputs,
    {
      source: 'fusion-pre-consolidate',
      sourceLabel: 'Fusion consolidate',
      recipientSummary: toAddress,
      amountSummary: 'self-consolidate before CashFusion',
    }
  );
  if (sent.errorMessage || !sent.txid) {
    return {
      ok: false,
      reason: sent.errorMessage || 'pre-fusion consolidate broadcast failed',
    };
  }
  return {
    ok: true,
    txid: sent.txid,
    fromAddress: bucket.address,
    toAddress,
    coinCount: built.inputs.length,
  };
}
