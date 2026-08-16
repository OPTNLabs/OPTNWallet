import KeyService from '../../../services/KeyService';
import {
  buildCauldronMerchantPaymentRequest,
  resolveCauldronFundingInputs,
  signAndBroadcastCauldronMerchantPaymentRequest,
  type BuiltCauldronMerchantPaymentRequest,
  type CauldronPoolTrade,
} from '../../../services/cauldron';
import type { UTXO } from '../../../types/types';
import { selectLargestBchUtxos } from '../cauldron/funding';

function toWalletAddressSet(
  entries: Array<{ address: string; tokenAddress?: string }>
): Set<string> {
  return new Set(
    entries.flatMap((entry) =>
      [entry.address, entry.tokenAddress].filter(
        (address): address is string => Boolean(address)
      )
    )
  );
}

export async function buildMerchantPaymentWithFunding(params: {
  walletId: number;
  allUtxos: UTXO[];
  trades: CauldronPoolTrade[];
  merchantAddress: string;
  changeAddress: string;
  tokenChangeAddress?: string;
  feeRate: bigint;
  userPrompt: string;
  sequence?: number;
}) {
  const {
    walletId,
    allUtxos,
    trades,
    merchantAddress,
    changeAddress,
    tokenChangeAddress,
    feeRate,
    userPrompt,
    sequence,
  } = params;

  const walletKeys = await KeyService.retrieveKeys(walletId);
  const quantumrootVaults =
    await KeyService.retrieveQuantumrootVaults(walletId);
  const allowedWalletAddresses = toWalletAddressSet(walletKeys);
  for (const vault of quantumrootVaults) {
    if (vault.receive_address) {
      allowedWalletAddresses.add(vault.receive_address);
    }
    if (vault.quantum_lock_address) {
      allowedWalletAddresses.add(vault.quantum_lock_address);
    }
  }

  const signableUtxos = allUtxos.filter(
    (utxo) =>
      allowedWalletAddresses.has(utxo.address) ||
      (utxo.tokenAddress != null &&
        allowedWalletAddresses.has(utxo.tokenAddress))
  );
  const sortedBchUtxos = selectLargestBchUtxos(signableUtxos);

  for (let i = 1; i <= sortedBchUtxos.length; i += 1) {
    const selected = sortedBchUtxos.slice(0, i);
    try {
      const walletInputs = await resolveCauldronFundingInputs(walletId, selected);
      return buildCauldronMerchantPaymentRequest({
        poolTrades: trades,
        walletInputs,
        merchantAddress,
        changeAddress,
        tokenChangeAddress,
        feeRateSatsPerByte: feeRate,
        userPrompt,
        sequence,
      });
    } catch {
      // Keep expanding the BCH funding set until the transaction can be built.
    }
  }

  throw new Error(
    'Not enough BCH UTXOs are available for this merchant payment.'
  );
}

export async function signAndBroadcastMerchantPayment(
  walletId: number,
  built: BuiltCauldronMerchantPaymentRequest,
  options?: {
    sourceLabel?: string | null;
    recipientSummary?: string | null;
    amountSummary?: string | null;
    userPrompt?: string | null;
  }
) {
  return signAndBroadcastCauldronMerchantPaymentRequest(walletId, built, {
    sourceLabel: options?.sourceLabel ?? 'Merchant Pay',
    recipientSummary: options?.recipientSummary ?? null,
    amountSummary: options?.amountSummary ?? null,
    userPrompt: options?.userPrompt ?? built.signRequest.transaction.userPrompt ?? null,
  });
}

export type { BuiltCauldronMerchantPaymentRequest };
