import { binToHex, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import type { UTXO, Token, TransactionOutput } from '../../types/types';
import type { PsbtTokenSpec } from '../../services/psbt/psbtBch';
import type { WatchOnlyBuildOutput } from '../../services/psbt/watchOnlySend';
import type { ReviewState } from '../simple-send/types';
import { ReviewCard } from '../simple-send/ReviewCard';

type MultisigBroadcastReviewProps = {
  open: boolean;
  recipient: string;
  amountSats: bigint;
  inputSumSats: bigint;
  feeSats: bigint;
  outputs: WatchOnlyBuildOutput[];
  selectedInputs: UTXO[];
  rawTxHex: string;
  network: string;
  policyId: string;
  threshold: number;
  signerCount: number;
  isSending: boolean;
  onClose: () => void;
  onConfirmSend: () => void;
};

const capabilityFor = (
  capability: number | undefined
): 'none' | 'mutable' | 'minting' =>
  capability === 1 ? 'mutable' : capability === 2 ? 'minting' : 'none';

function toTransactionToken(token: PsbtTokenSpec): Token {
  return {
    category: binToHex(token.category),
    amount: token.amount ?? 0n,
    ...(token.capability !== undefined || token.commitment !== undefined
      ? {
          nft: {
            capability: capabilityFor(token.capability),
            commitment: binToHex(token.commitment ?? new Uint8Array()),
          },
        }
      : {}),
  };
}

function toReviewOutputs(
  outputs: WatchOnlyBuildOutput[],
  network: string
): TransactionOutput[] {
  const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
  return outputs.map((output) => {
    const encoded = lockingBytecodeToCashAddress({
      bytecode: Uint8Array.from(
        output.lockingBytecodeHex
          .match(/.{1,2}/g)
          ?.map((byte) => Number.parseInt(byte, 16)) ?? []
      ),
      prefix,
    });
    return {
      recipientAddress: typeof encoded === 'string' ? '' : encoded.address,
      amount: output.satoshis,
      ...(output.token ? { token: toTransactionToken(output.token) } : {}),
    };
  });
}

/**
 * Multisig-owned broadcast confirmation. It deliberately reuses the same
 * review interaction as Simple Send, but keeps the policy identity visible so
 * a coordinator cannot be mistaken for the standard mnemonic wallet.
 */
export default function MultisigBroadcastReview({
  open,
  recipient,
  amountSats,
  inputSumSats,
  feeSats,
  outputs,
  selectedInputs,
  rawTxHex,
  network,
  policyId,
  threshold,
  signerCount,
  isSending,
  onClose,
  onConfirmSend,
}: MultisigBroadcastReviewProps) {
  const review: ReviewState = {
    rawTx: rawTxHex,
    feeSats: Number(feeSats),
    totalSats: Number(inputSumSats),
    finalOutputs: toReviewOutputs(outputs, network),
  };

  return (
    <ReviewCard
      open={open}
      review={review}
      recipient={recipient}
      assetType="bch"
      amountBch={(Number(amountSats) / 100_000_000).toFixed(8)}
      fiatSummary={{ amountUsd: 0, feeUsd: 0, totalUsd: 0 }}
      selectedCategory=""
      amountToken=""
      tokenMeta={{}}
      displayNameFor={(category) => category}
      selectedForTx={selectedInputs}
      rawHexLen={rawTxHex.length}
      isSending={isSending}
      reviewContext={`Multisig policy ${policyId} · ${threshold} of ${signerCount} signatures`}
      onClose={onClose}
      onConfirmSend={onConfirmSend}
    />
  );
}
