import type { UTXO } from '../../../types/types';
import type { MerchantPaymentProposal } from './merchantPaymentProposal';

export type MerchantPaymentMonitorStatus =
  | 'awaiting-buyer'
  | 'pending'
  | 'confirmed'
  | 'expired'
  | 'error';

export type MerchantPaymentObservation = {
  status: 'pending' | 'confirmed';
  txid: string;
  outpoint: string;
  height: number;
};

function outpointKey(utxo: Pick<UTXO, 'tx_hash' | 'tx_pos'>): string {
  return `${utxo.tx_hash.toLowerCase()}:${utxo.tx_pos}`;
}

function parseTokenAmount(value: number | bigint): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * Finds the exact new token UTXO created for a merchant proposal.
 *
 * Existing merchant outputs are excluded using the request-time snapshot so
 * a pre-existing balance cannot make an unpaid request appear complete.
 */
export function findMerchantPaymentObservation(params: {
  utxos: UTXO[];
  baselineOutpoints: readonly string[];
  proposal: MerchantPaymentProposal;
}): MerchantPaymentObservation | null {
  const baseline = new Set(
    params.baselineOutpoints.map((outpoint) => outpoint.toLowerCase())
  );
  const expectedCategory = params.proposal.tokenId.toLowerCase();
  const expectedTokenAmount =
    params.proposal.version === 2
      ? params.proposal.merchantTokenAmountAtomic
      : params.proposal.tokenAmountAtomic;
  const expectedBchAmount =
    params.proposal.version === 2
      ? params.proposal.merchantBchAmountSatoshis
      : 0n;
  const outputsByTransaction = new Map<
    string,
    { utxos: UTXO[]; tokenAmount: bigint; bchAmount: bigint }
  >();

  for (const utxo of params.utxos) {
    const outpoint = outpointKey(utxo);
    if (baseline.has(outpoint)) continue;
    const txid = utxo.tx_hash.toLowerCase();
    const group = outputsByTransaction.get(txid) ?? {
      utxos: [],
      tokenAmount: 0n,
      bchAmount: 0n,
    };
    group.utxos.push(utxo);
    if (utxo.token && utxo.token.category.toLowerCase() === expectedCategory) {
      group.tokenAmount += parseTokenAmount(utxo.token.amount) ?? 0n;
    } else if (!utxo.token) {
      group.bchAmount += BigInt(utxo.value ?? utxo.amount ?? 0);
    }
    outputsByTransaction.set(txid, group);
  }

  for (const group of outputsByTransaction.values()) {
    if (
      group.tokenAmount !== expectedTokenAmount ||
      group.bchAmount !== expectedBchAmount
    ) {
      continue;
    }

    const firstOutput = group.utxos[0];
    if (!firstOutput) continue;
    const matchingOutpoint = outpointKey(
      group.utxos.find((utxo) => {
        if (expectedTokenAmount > 0n) {
          return Boolean(
            utxo.token && utxo.token.category.toLowerCase() === expectedCategory
          );
        }
        return !utxo.token;
      }) ?? firstOutput
    );
    const height = group.utxos.reduce(
      (minimum, utxo) => Math.min(minimum, utxo.height),
      firstOutput.height
    );
    return {
      status: height > 0 ? 'confirmed' : 'pending',
      txid: firstOutput.tx_hash,
      outpoint: matchingOutpoint,
      height,
    };
  }

  return null;
}
