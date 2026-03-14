import { decodeCashAddress, encodeCashAddress } from '@bitauth/libauth';
import { createSimpleSendPlanner } from '../../../../hooks/simple-send/planner';
import { selectTokenFtInputs } from '../../../../services/CoinSelectionService';
import TransactionService from '../../../../services/TransactionService';
import type { AddonSDK } from '../../../../services/AddonsSDK';
import type { TransactionOutput, UTXO } from '../../../../types/types';
import type { DistributionJobRecord } from '../types';
import { TOKEN_OUTPUT_SATS } from '../../../../utils/constants';

type CompleteDistributionJobArgs = {
  jobId: string;
  status: string;
  txid?: string;
};

type DistributionCompletionApi = {
  completeDistributionJob(args: CompleteDistributionJobArgs): Promise<unknown>;
};

function toTokenAwareAddress(address: string): string {
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string') {
    throw new Error(`Invalid recipient address: ${address}`);
  }

  if (
    decoded.type === 'p2pkhWithTokens' ||
    decoded.type === 'p2shWithTokens'
  ) {
    return address;
  }

  if (decoded.type === 'p2pkh') {
    return encodeCashAddress({
      prefix: decoded.prefix,
      type: 'p2pkhWithTokens',
      payload: decoded.payload,
    }).address;
  }

  if (decoded.type === 'p2sh') {
    return encodeCashAddress({
      prefix: decoded.prefix,
      type: 'p2shWithTokens',
      payload: decoded.payload,
    }).address;
  }

  throw new Error(`Unsupported token recipient address type: ${address}`);
}

export type DistributionTxPreview = {
  rawTx: string;
  inputs: UTXO[];
  finalOutputs: TransactionOutput[];
  feeSats: number;
  totalSats: number;
  changeAddress: string;
  tokenChangeAddress: string;
  jobIds: string[];
};

export async function buildApprovedDistributionTransaction(
  sdk: AddonSDK,
  jobs: DistributionJobRecord[]
): Promise<DistributionTxPreview> {
  const utxoSats = (value: { value?: number; amount?: number }) =>
    Number(value.amount ?? value.value ?? 0);

  if (!jobs.length) {
    throw new Error('No prepared distribution jobs were provided.');
  }
  const preparedJobs = jobs.filter((job) => job.status === 'prepared');
  if (!preparedJobs.length) {
    throw new Error('No prepared distribution jobs are available to send.');
  }

  const assetType = preparedJobs[0].asset_type === 'bch' ? 'bch' : 'token';
  const inconsistentAsset = preparedJobs.some(
    (job) => (job.asset_type === 'bch' ? 'bch' : 'token') !== assetType
  );
  if (inconsistentAsset) {
    throw new Error('Prepared jobs must use the same asset type for batch sending.');
  }

  const tokenCategory =
    assetType === 'token' ? preparedJobs[0].token_category || '' : '';
  if (
    assetType === 'token' &&
    preparedJobs.some((job) => (job.token_category || '') !== tokenCategory)
  ) {
    throw new Error('Prepared token jobs must use the same token category for batch sending.');
  }
  if (preparedJobs.some((job) => !job.amount || !job.destination_address)) {
    throw new Error('One or more prepared jobs are missing required details.');
  }

  const [addresses, walletUtxos] = await Promise.all([
    sdk.wallet.listAddresses(),
    sdk.utxos.listForWallet(),
  ]);
  const selectedChangeAddress = addresses[0]?.address || '';
  const tokenChangeAddress = addresses[0]?.tokenAddress || selectedChangeAddress;
  if (!selectedChangeAddress) {
    throw new Error('No wallet change address is available.');
  }

  const planner = createSimpleSendPlanner({
    recipient: preparedJobs[0].destination_address,
    selectedCategory: tokenCategory,
    amountToken: preparedJobs[0].amount,
    tokenChangeAddress,
    selectedChangeAddress,
    dbUtxos: walletUtxos.allUtxos.filter((utxo) => !utxo.token),
  });

  let built;
  if (assetType === 'bch') {
    const outputs: TransactionOutput[] = [];
    for (const job of preparedJobs) {
      const bchAmount = Number(job.amount);
      if (!Number.isFinite(bchAmount) || bchAmount <= 0) {
        throw new Error('Invalid BCH amount for distribution.');
      }
      outputs.push({
        recipientAddress: job.destination_address,
        amount: bchAmount,
      });
    }
    built = await planner.addBchInputsUntilBuild([], outputs, 100);
  } else {
    if (!tokenCategory) {
      throw new Error('Token distribution job is missing a token category.');
    }
    const tokenAmount = preparedJobs.reduce(
      (sum, job) => sum + BigInt(job.amount),
      0n
    );
    const { tokenInputs } = selectTokenFtInputs(
      tokenCategory,
      walletUtxos.tokenUtxos,
      tokenAmount,
      { preferConfirmed: false, maxInputs: 100 }
    );
    if (!tokenInputs.length) {
      throw new Error('No token UTXOs available for the selected category.');
    }

    const totalFromInputs = tokenInputs.reduce((sum, utxo) => {
      const amountRaw = utxo.token?.amount ?? 0;
      const amount =
        typeof amountRaw === 'bigint' ? amountRaw : BigInt(Math.trunc(amountRaw));
      return sum + amount;
    }, 0n);
    const totalTokenInputSats = tokenInputs.reduce(
      (sum, utxo) => sum + utxoSats(utxo),
      0
    );
    if (totalFromInputs < tokenAmount) {
      throw new Error('Insufficient token balance for this request.');
    }

    const outputs: TransactionOutput[] = preparedJobs.map((job) => ({
      recipientAddress: toTokenAwareAddress(job.destination_address),
      amount: TOKEN_OUTPUT_SATS,
      token: {
        category: tokenCategory,
        amount: BigInt(job.amount),
      },
    }));
    const changeTokenAmount = totalFromInputs - tokenAmount;
    if (changeTokenAmount > 0n) {
      const tokenChangeOutput = planner.makeTokenChangeOutputFT(changeTokenAmount);
      tokenChangeOutput.amount = Math.max(totalTokenInputSats, TOKEN_OUTPUT_SATS);
      outputs.push(tokenChangeOutput);
    }

    built = await planner.addBchInputsUntilBuild(tokenInputs, outputs, 100);
  }

  if (!('ok' in built) || !built.ok) {
    throw new Error('err' in built ? built.err : 'Failed to prepare send transaction.');
  }

  return {
    rawTx: built.rawTx,
    inputs: built.inputs,
    finalOutputs: built.finalOutputs ?? [],
    feeSats: built.feeSats,
    totalSats: built.totalSats,
    changeAddress: selectedChangeAddress,
    tokenChangeAddress,
    jobIds: preparedJobs.map((job) => job.id),
  };
}

export async function executeApprovedDistributionSend(
  sdk: AddonSDK,
  api: DistributionCompletionApi,
  jobs: DistributionJobRecord[]
) {
  const preview = await buildApprovedDistributionTransaction(sdk, jobs);

  const sent = await TransactionService.sendTransaction(preview.rawTx, preview.inputs, {
    source: 'event-rewards',
    sourceLabel: 'Event Rewards',
    amountSummary: `${preview.jobIds.length} recipient${preview.jobIds.length === 1 ? '' : 's'}`,
  });
  if (sent.errorMessage) {
    throw new Error(sent.errorMessage);
  }
  if (!sent.txid) {
    throw new Error('Broadcast failed with no txid returned.');
  }

  await Promise.all(
    preview.jobIds.map((jobId) =>
      api.completeDistributionJob({
        jobId,
        status:
          sent.broadcastState === 'submitted'
            ? 'pending_broadcast_verification'
            : 'sent',
        txid: sent.txid,
      })
    )
  );

  return {
    txid: sent.txid,
    broadcastState: sent.broadcastState,
    spentInputs: preview.inputs,
    finalOutputs: preview.finalOutputs,
    jobIds: preview.jobIds,
  };
}
