import { formatAtomicTokenAmount } from '../../../utils/tokenPresentation';

export function formatDistributionTotal(
  atomicAmount: bigint,
  asset: { kind: 'bch' } | { kind: 'token'; decimals: number; label: string }
): string {
  return asset.kind === 'bch'
    ? `${formatAtomicTokenAmount(atomicAmount, 8)} BCH`
    : `${formatAtomicTokenAmount(atomicAmount, asset.decimals)} ${asset.label}`;
}
