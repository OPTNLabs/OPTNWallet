import { useCallback, useMemo } from 'react';
import { shortenTxHash } from '../../utils/shortenHash';
import { PREFIX } from '../../utils/constants';
import {
  AssetType,
  CategorySummary,
  InputTableRow,
  OutputTableRow,
  ReviewState,
  SimpleSendInput,
  TokenMetaMap,
} from './types';
import { displayNameFor } from './utils';

type UseSimpleSendViewModelParams = {
  currentNetwork: string;
  categories: CategorySummary[];
  tokenMeta: TokenMetaMap;
  selectedForTx: SimpleSendInput[] | undefined;
  review: ReviewState | null;
  assetType: AssetType;
  recipient: string;
  amountBch: string;
  selectedCategory: string;
  amountToken: string;
};

export function useSimpleSendViewModel({
  currentNetwork,
  categories,
  tokenMeta,
  selectedForTx,
  review,
  assetType,
  recipient,
  amountBch,
  selectedCategory,
  amountToken,
}: UseSimpleSendViewModelParams) {
  const displayTokenName = useCallback(
    (category: string) => displayNameFor(category, tokenMeta),
    [tokenMeta]
  );

  const prefixLen = PREFIX[currentNetwork]?.length ?? 0;
  const mask = useCallback(
    (addr: string) => shortenTxHash(addr, prefixLen),
    [prefixLen]
  );

  const inputSum = useMemo(() => {
    if (!Array.isArray(selectedForTx)) return 0n;
    return selectedForTx.reduce((s, u) => s + BigInt(u?.amount ?? u?.value ?? 0), 0n);
  }, [selectedForTx]);

  const outputsTableRows = useMemo<OutputTableRow[]>(() => {
    if (!review?.finalOutputs?.length) return [];
    return review.finalOutputs.map((o, idx) => {
      if ('opReturn' in o && o.opReturn) {
        return {
          i: idx,
          type: 'OP_RETURN',
          address: '—',
          amount: 0,
          token: '—',
          details: o.opReturn.join(' | '),
        };
      }

      const token = o.token
        ? JSON.stringify(
            {
              ...o.token,
              amount:
                typeof o.token.amount === 'bigint'
                  ? o.token.amount.toString()
                  : o.token.amount,
            },
            null,
            0
          )
        : '—';

      return {
        i: idx,
        type: 'P2PKH',
        address: mask(o.recipientAddress || ''),
        amount: Number(o.amount || 0),
        token,
        details: '',
      };
    });
  }, [review, mask]);

  const inputsTableRows = useMemo<InputTableRow[]>(() => {
    if (!Array.isArray(selectedForTx)) return [];
    return selectedForTx.map((u, idx) => ({
      i: idx,
      outpoint: `${u?.tx_hash}:${u?.tx_pos}`,
      address: mask(u?.address || ''),
      amount: Number(u?.amount ?? u?.value ?? 0),
      height: u?.height ?? 0,
      token: u?.token ? 'yes' : 'no',
      contract: u?.abi || u?.contractName ? 'yes' : 'no',
    }));
  }, [selectedForTx, mask]);

  const rawHexLen = review?.rawTx ? review.rawTx.length : 0;

  const ftCategories = categories.filter((c) => c.ftAmount > 0n);
  const nftCategories = categories.filter((c) => c.isNft);

  const canReview =
    (assetType === 'bch' && !!recipient && !!amountBch) ||
    (assetType === 'ft' && !!recipient && !!selectedCategory && !!amountToken) ||
    (assetType === 'nft' && !!recipient && !!selectedCategory);

  const inputClass =
    'w-full wallet-input wallet-focus-field rounded-xl';
  const selectClass =
    'w-full wallet-input wallet-focus-field appearance-none rounded-xl cursor-pointer';

  return {
    displayTokenName,
    prefixLen,
    mask,
    inputSum,
    outputsTableRows,
    inputsTableRows,
    rawHexLen,
    ftCategories,
    nftCategories,
    canReview,
    inputClass,
    selectClass,
  };
}
