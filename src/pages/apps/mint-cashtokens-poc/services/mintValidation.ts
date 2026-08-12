import type { MintAppUtxo, MintOutputDraft } from '../types';
import {
  shortHash,
  toBigIntSafe,
  utxoKey,
  validateCategoryReuseRules,
} from '../utils';
import {
  canMintFungibleFromSource,
  isSelectableMintSource,
  selectMintSourceUtxos,
} from '../utils/sourceHelpers';

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
  const invalidSelectedSource = selectedUtxos.find(
    (utxo) => !isSelectableMintSource(utxo)
  );
  if (invalidSelectedSource) {
    return 'Only genesis UTXOs or minting authority NFTs can be used as mint sources.';
  }
  const selectedSourceUtxos = selectMintSourceUtxos(selectedUtxos);
  if (selectedSourceUtxos.length === 0) {
    return 'Select at least one source UTXO.';
  }
  if (activeOutputDrafts.length === 0)
    return 'Add at least one output mapping in Amounts.';

  const sourceByKeyForValidation = new Map(
    selectedSourceUtxos.map((u) => [utxoKey(u), u] as const)
  );
  const selectedSourceKeys = new Set(selectedSourceKeySet);
  for (const sourceKey of selectedSourceKeys) {
    if (!activeOutputDrafts.some((draft) => draft.sourceKey === sourceKey)) {
      return 'Each selected source UTXO needs at least one output mapping.';
    }
  }

  for (const d of activeOutputDrafts) {
    if (!selectedRecipientSet.has(d.recipientCashAddr)) {
      return 'An output references an unselected recipient.';
    }
    if (!selectedSourceKeySet.has(d.sourceKey)) {
      return 'An output references an unselected source UTXO.';
    }
    const source = sourceByKeyForValidation.get(d.sourceKey);
    if (d.config.mintType === 'FT' && source && !canMintFungibleFromSource(source)) {
      return 'Minting authority sources can only mint NFT outputs.';
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
