import type { MintAppUtxo, MintOutputDraft } from '../types';
import {
  shortHash,
  toBigIntSafe,
  utxoKey,
  validateCategoryReuseRules,
} from '../utils';

type ValidateMintRequestParams = {
  walletId: number | null | undefined;
  selectedRecipientCount: number;
  changeAddress: string;
  selectedUtxos: MintAppUtxo[];
  activeOutputDrafts: MintOutputDraft[];
  selectedRecipientSet: ReadonlySet<string>;
  selectedSourceKeySet: ReadonlySet<string>;
};

export function validateMintRequest(
  params: ValidateMintRequestParams
): string | null {
  const {
    walletId,
    selectedRecipientCount,
    changeAddress,
    selectedUtxos,
    activeOutputDrafts,
    selectedRecipientSet,
    selectedSourceKeySet,
  } = params;

  if (!walletId || walletId <= 0) return 'No wallet selected.';
  if (selectedRecipientCount === 0)
    return 'Please select at least one recipient address.';
  if (!changeAddress) return 'Change address not ready.';
  if (selectedUtxos.length === 0) {
    return 'Select at least one Candidate UTXO.';
  }
  if (activeOutputDrafts.length === 0)
    return 'Add at least one output mapping in Amounts.';

  for (const d of activeOutputDrafts) {
    if (!selectedRecipientSet.has(d.recipientCashAddr)) {
      return 'An output references an unselected recipient.';
    }
    if (!selectedSourceKeySet.has(d.sourceKey)) {
      return 'An output references an unselected Candidate UTXO.';
    }
    if (d.config.mintType === 'FT') {
      const amt = toBigIntSafe(d.config.ftAmount);
      if (amt <= 0n) {
        return `FT amount must be > 0 for ${shortHash(
          d.sourceKey,
          10,
          0
        )} → ${shortHash(d.recipientCashAddr, 12, 8)}`;
      }
    }
  }

  const sourceByKeyForValidation = new Map(
    selectedUtxos
      .filter((u) => u.tx_pos === 0 && !u.token)
      .map((u) => [utxoKey(u), u] as const)
  );
  const categoryRule = validateCategoryReuseRules(
    activeOutputDrafts,
    sourceByKeyForValidation
  );
  if (!categoryRule.ok) {
    return 'message' in categoryRule
      ? categoryRule.message
      : 'Category reuse validation failed.';
  }

  return null;
}
