import type { AddonSDK } from '../../../services/AddonsSDK';
import type { CauldronPoolTrade } from '../../../services/cauldron';
import OutboundTransactionTracker from '../../../services/OutboundTransactionTracker';
import { sumSpendableBchBalance } from '../cauldron/funding';
import type { MerchantPaymentRequest } from './merchantPayRequest';
import type { MerchantStablecoin } from './merchantStablecoins';
import {
  buildMerchantPaymentWithFunding,
  signAndBroadcastMerchantPayment,
} from './merchantPayTransactions';

export const MERCHANT_SETTLEMENT_FEE_RATE = 2n;

function getOutpointKey(utxo: { tx_hash: string; tx_pos: number }): string {
  return `${utxo.tx_hash}:${utxo.tx_pos}`;
}

export type MerchantAutoSettleResult =
  | {
      status: 'waiting';
      availableBchSats: bigint;
    }
  | {
      status: 'settled';
      availableBchSats: bigint;
      txid: string | null;
    };

export async function attemptMerchantAutoSettlement(params: {
  sdk: AddonSDK;
  walletId: number;
  paymentRequest: MerchantPaymentRequest;
  draftTrades: CauldronPoolTrade[];
  selectedStablecoin: MerchantStablecoin;
}): Promise<MerchantAutoSettleResult> {
  if (params.draftTrades.length === 0) {
    throw new Error('No Cauldron route is available for settlement.');
  }

  const receiveUtxos = await params.sdk.utxos.listForAddress(
    params.paymentRequest.merchantAddress
  );
  const outboundRecords = await OutboundTransactionTracker.listAll(
    params.walletId
  );
  const outboundTxids = new Set(outboundRecords.map((record) => record.txid));
  const baselineOutpoints = new Set(
    params.paymentRequest.merchantAddressBaselineOutpoints ?? []
  );
  const incomingUtxos = receiveUtxos.filter(
    (utxo) =>
      !baselineOutpoints.has(getOutpointKey(utxo)) &&
      !outboundTxids.has(utxo.tx_hash) &&
      !utxo.token
  );
  const availableBchSats = sumSpendableBchBalance(incomingUtxos);

  if (availableBchSats < params.paymentRequest.customerPaysSats) {
    return {
      status: 'waiting',
      availableBchSats,
    };
  }

  const walletAddresses = await params.sdk.wallet.listAddresses();
  const requestWalletAddress = walletAddresses.find(
    (entry) =>
      entry.address === params.paymentRequest.merchantAddress ||
      entry.tokenAddress === params.paymentRequest.merchantAddress
  );
  const settlementAddress =
    (await params.sdk.wallet.toTokenAddress(
      params.paymentRequest.merchantAddress
    ).catch(() => '')) ||
    requestWalletAddress?.tokenAddress ||
    requestWalletAddress?.address ||
    walletAddresses[0]?.tokenAddress ||
    walletAddresses[0]?.address ||
    '';
  if (!settlementAddress) {
    throw new Error('No settlement address is available.');
  }

  const changeAddress = walletAddresses[0]?.address || settlementAddress;
  const tokenChangeAddress =
    walletAddresses[0]?.tokenAddress ||
    walletAddresses[0]?.address ||
    settlementAddress;

  const built = await buildMerchantPaymentWithFunding({
    walletId: params.walletId,
    allUtxos: incomingUtxos,
    trades: params.draftTrades,
    merchantAddress: settlementAddress,
    changeAddress,
    tokenChangeAddress,
    feeRate: MERCHANT_SETTLEMENT_FEE_RATE,
    userPrompt: `Merchant Pay settlement ${params.paymentRequest.requestId}`,
  });

  const broadcast = await signAndBroadcastMerchantPayment(
    params.walletId,
    built,
    {
      sourceLabel: 'Merchant Pay',
      recipientSummary: params.selectedStablecoin.name,
      amountSummary: params.paymentRequest.merchantReceivesDisplay,
      userPrompt: built.signRequest.transaction.userPrompt ?? null,
    }
  );

  if (!broadcast.txid) {
    throw new Error(
      broadcast.errorMessage ?? 'Unable to broadcast the merchant settlement.'
    );
  }

  return {
    status: 'settled',
    availableBchSats,
    txid: broadcast.txid,
  };
}
