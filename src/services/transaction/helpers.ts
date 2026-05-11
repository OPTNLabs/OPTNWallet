import { store } from '../../state/store';
import { logError } from '../../utils/errorHandling';
import KeyService from '../KeyService';
import OutboundTransactionTracker from '../OutboundTransactionTracker';
import { UTXO } from '../../types/types';
import type { SendTransactionOptions } from '../TransactionService';

export async function enrichTrackedAttempt(
  rawTX: string,
  spentInputs?: UTXO[],
  options?: SendTransactionOptions
): Promise<void> {
  const currentWalletId = store.getState().wallet_id.currentWalletId ?? null;
  await OutboundTransactionTracker.trackAttempt({
    rawTx: rawTX,
    walletId: currentWalletId,
    source: options?.source ?? 'wallet',
    sourceLabel: options?.sourceLabel ?? null,
    recipientSummary: options?.recipientSummary ?? null,
    amountSummary: options?.amountSummary ?? null,
    sessionTopic: options?.sessionTopic ?? null,
    dappName: options?.dappName ?? null,
    dappUrl: options?.dappUrl ?? null,
    requestId: options?.requestId ?? null,
    userPrompt: options?.userPrompt ?? null,
    spentInputs,
  });
}

export async function collectRefreshAddresses(spentInputs?: UTXO[]): Promise<string[]> {
  const currentWalletId = store.getState().wallet_id.currentWalletId ?? null;
  const addrs = new Set<string>(
    spentInputs?.map((u) => u.address).filter(Boolean) ?? []
  );
  if (currentWalletId) {
    try {
      const keyPairs = await KeyService.retrieveKeys(currentWalletId);
      for (const key of keyPairs ?? []) {
        if (key.address) addrs.add(key.address);
      }
    } catch (error) {
      logError(
        'TransactionService.collectRefreshAddresses.retrieveKeysAfterBroadcast',
        error,
        { walletId: currentWalletId }
      );
    }
  }
  return Array.from(addrs);
}

export function schedulePostBroadcastRefresh(
  requestUTXORefreshForMany: (addresses: string[], delayMs: number) => void,
  addresses: string[]
): void {
  const unique = Array.from(new Set(addresses.filter(Boolean)));
  if (unique.length === 0) return;

  requestUTXORefreshForMany(unique, 0);
  requestUTXORefreshForMany(unique, 1500);
}
