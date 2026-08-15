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
  proposal: Pick<MerchantPaymentProposal, 'tokenId' | 'tokenAmountAtomic'>;
}): MerchantPaymentObservation | null {
  const baseline = new Set(
    params.baselineOutpoints.map((outpoint) => outpoint.toLowerCase())
  );
  const expectedCategory = params.proposal.tokenId.toLowerCase();

  for (const utxo of params.utxos) {
    const outpoint = outpointKey(utxo);
    if (baseline.has(outpoint)) continue;
    if (!utxo.token || utxo.token.category.toLowerCase() !== expectedCategory) {
      continue;
    }

    const tokenAmount = parseTokenAmount(utxo.token.amount);
    if (tokenAmount !== params.proposal.tokenAmountAtomic) continue;

    return {
      status: utxo.height > 0 ? 'confirmed' : 'pending',
      txid: utxo.tx_hash,
      outpoint,
      height: utxo.height,
    };
  }

  return null;
}
