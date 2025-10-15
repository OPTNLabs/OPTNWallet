// src/hooks/useSimpleSend.ts
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import { selectWalletId } from '../redux/walletSlice';
import useFetchWalletData from './useFetchWalletData';
import { UTXO, TransactionOutput } from '../types/types';
import TransactionService from '../services/TransactionService';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { SATSINBITCOIN } from '../utils/constants';
import UTXOService from '../services/UTXOService';
import {
  selectForBch,
  selectTokenFtByCategory,
  selectNftByCategory,
} from '../services/CoinSelectionService';

type ReviewState = {
  rawTx: string;
  feeSats: number;
  totalSats: number;
  finalOutputs: TransactionOutput[];
};
type SimpleSendMode = 'idle' | 'review' | 'sending' | 'sent' | 'error';
type AssetType = 'bch' | 'ft' | 'nft';

export default function useSimpleSend() {
  const prices = useSelector((s: RootState) => s.priceFeed);
  const walletId = useSelector(selectWalletId);
  const currentNetwork = useSelector((s: RootState) => selectCurrentNetwork(s));

  // Wallet addresses + default change
  const [addresses, setAddresses] = useState<
    { address: string; tokenAddress: string }[]
  >([]);
  const [defaultChangeAddress, setDefaultChangeAddress] = useState<string>('');
  const [error, setError] = useState<string>('');
  useFetchWalletData(
    walletId,
    setAddresses,
    (() => {}) as any,
    (() => {}) as any,
    (() => {}) as any,
    setDefaultChangeAddress,
    setError
  );

  // All UTXOs
  const [bchUtxos, setBchUtxos] = useState<UTXO[]>([]);
  const [tokenUtxos, setTokenUtxos] = useState<UTXO[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!walletId) return;
      const { allUtxos, tokenUtxos } =
        await UTXOService.fetchAllWalletUtxos(walletId);
      if (!cancelled) {
        setBchUtxos(allUtxos); // already non-token per manager
        setTokenUtxos(tokenUtxos || []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [walletId, addresses.length]);

  // Change address
  const [selectedChangeAddress, setSelectedChangeAddress] =
    useState<string>('');
  useEffect(() => {
    if (!selectedChangeAddress) {
      setSelectedChangeAddress(
        defaultChangeAddress || addresses[0]?.address || ''
      );
    }
  }, [defaultChangeAddress, addresses, selectedChangeAddress]);

  // Form
  const [assetType, setAssetType] = useState<AssetType>('bch');
  const [recipient, setRecipient] = useState<string>('');
  const [amountBch, setAmountBch] = useState<string>(''); // BCH amount
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [tokenAmount, setTokenAmount] = useState<string>(''); // FT amount (integer for now)
  const [selectedNft, setSelectedNft] = useState<{
    commitment: string;
    capability: 'none' | 'mutable' | 'minting';
  } | null>(null);

  // Derived token data
  const tokenCategories = useMemo(() => {
    const cats = Array.from(
      new Set(
        tokenUtxos
          .filter((u) => !!u.token?.category)
          .map((u) => u.token!.category)
      )
    );
    // Keep currently selected if still present
    if (!selectedCategory && cats.length) setSelectedCategory(cats[0]);
    return cats;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenUtxos.length]);

  const availableNfts = useMemo(() => {
    if (!selectedCategory) return [];
    return tokenUtxos
      .filter((u) => u.token?.category === selectedCategory && !!u.token?.nft)
      .map((u) => ({
        commitment: u.token!.nft!.commitment,
        capability: u.token!.nft!.capability,
      }));
  }, [tokenUtxos, selectedCategory]);

  // Flow state
  const [mode, setMode] = useState<SimpleSendMode>('idle');
  const [review, setReview] = useState<ReviewState | null>(null);
  const [selectedForTx, setSelectedForTx] = useState<UTXO[]>([]);
  const [txid, setTxid] = useState<string>('');

  const priceUsd = Number(prices['BCH'] || 0);

  const reset = useCallback(() => {
    setMode('idle');
    setError('');
    setReview(null);
    setSelectedForTx([]);
    setTxid('');
  }, []);

  const validateRecipient = (addr: string) =>
    typeof addr === 'string' && addr.trim().length > 10;

  const parseAmountToSats = (val: string): number => {
    const n = Number(val);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n * SATSINBITCOIN);
  };

  async function tryBuild(outputs: TransactionOutput[], inputs: UTXO[]) {
    try {
      const r = await TransactionService.buildTransaction(
        outputs,
        null,
        selectedChangeAddress,
        inputs
      );
      if (r.errorMsg) return { ok: false, err: r.errorMsg };
      return {
        ok: true,
        feeSats: r.bytecodeSize,
        rawTx: r.finalTransaction,
        finalOutputs: r.finalOutputs ?? [],
      };
    } catch (e: any) {
      return { ok: false, err: e?.message || 'build failed' };
    }
  }

  async function growBchForFees(
    outputs: TransactionOutput[],
    fixedInputs: UTXO[],
    maxInputs = 50
  ) {
    // Add BCH inputs (no tokens) until a build succeeds
    const pool = [...bchUtxos]
      .filter((u) => u.height > 0) // prefer confirmed
      .sort((a, b) =>
        Number(BigInt(b.amount ?? b.value) - BigInt(a.amount ?? a.value))
      );

    for (let k = 0; k <= Math.min(maxInputs, pool.length); k++) {
      const inputs = [...fixedInputs, ...pool.slice(0, k)];
      const res = await tryBuild(outputs, inputs);
      if (res.ok) return { ...res, inputs };
    }
    // try including unconfirmed if needed
    const alt = [...bchUtxos].sort((a, b) =>
      Number(BigInt(b.amount ?? b.value) - BigInt(a.amount ?? a.value))
    );
    for (let k = 0; k <= Math.min(maxInputs, alt.length); k++) {
      const inputs = [...fixedInputs, ...alt.slice(0, k)];
      const res = await tryBuild(outputs, inputs);
      if (res.ok) return { ...res, inputs };
    }
    return { ok: false, err: 'Insufficient BCH for fees.' } as const;
  }

  const doReview = useCallback(async () => {
    try {
      setError('');

      if (!validateRecipient(recipient)) {
        setError('Please enter a valid recipient address.');
        setMode('error');
        return;
      }
      if (!selectedChangeAddress) {
        setError('Please choose a change address.');
        setMode('error');
        return;
      }

      // ===== BCH only =====
      if (assetType === 'bch') {
        const targetSats = parseAmountToSats(amountBch);
        if (targetSats <= 0) {
          setError('Amount must be greater than 0.');
          setMode('error');
          return;
        }
        if (!bchUtxos.length) {
          setError('No BCH UTXOs available.');
          setMode('error');
          return;
        }

        // Iterative builder using only BCH UTXOs
        const outputs: TransactionOutput[] = [
          { recipientAddress: recipient, amount: targetSats },
        ];
        // grow BCH inputs until build passes
        const attempt = await growBchForFees(outputs, []);
        if (!attempt.ok) {
          setError(attempt.err || 'Failed to prepare transaction.');
          setMode('error');
          return;
        }

        setSelectedForTx(attempt.inputs);
        setReview({
          rawTx: attempt.rawTx,
          feeSats: attempt.feeSats,
          totalSats: targetSats + attempt.feeSats,
          finalOutputs: attempt.finalOutputs,
        });
        setMode('review');
        return;
      }

      // ===== FT by category =====
      if (assetType === 'ft') {
        if (!selectedCategory) {
          setError('Choose a token category.');
          setMode('error');
          return;
        }
        const amt = BigInt(tokenAmount || '0');
        if (amt <= 0n) {
          setError('Token amount must be > 0.');
          setMode('error');
          return;
        }

        // 1) pick token UTXOs for this category
        const { selectedTokenUtxos, totalTokenAmount } =
          selectTokenFtByCategory(selectedCategory, amt, tokenUtxos, {
            preferConfirmed: true,
            maxInputs: 50,
          });

        if (totalTokenAmount < amt) {
          setError('Insufficient tokens in this category.');
          setMode('error');
          return;
        }

        // 2) build outputs with token
        const outputs: TransactionOutput[] = [
          {
            recipientAddress: recipient,
            amount: 546, // dust for token-bearing output; builder may adjust/change output set
            token: {
              category: selectedCategory,
              amount: amt, // FT
            } as any,
          },
        ];

        // 3) grow BCH inputs for fees (token inputs fixed)
        const attempt = await growBchForFees(outputs, selectedTokenUtxos);
        if (!attempt.ok) {
          setError(attempt.err || 'Failed to prepare token transaction.');
          setMode('error');
          return;
        }

        setSelectedForTx(attempt.inputs);
        setReview({
          rawTx: attempt.rawTx,
          feeSats: attempt.feeSats,
          totalSats: attempt.feeSats, // total BCH spent is just the fee (token value not counted as BCH)
          finalOutputs: attempt.finalOutputs,
        });
        setMode('review');
        return;
      }

      // ===== NFT by category =====
      if (assetType === 'nft') {
        if (!selectedCategory) {
          setError('Choose a token category.');
          setMode('error');
          return;
        }
        // pick exact NFT UTXO
        const { nftUtxo } = selectNftByCategory(selectedCategory, tokenUtxos, {
          preferConfirmed: true,
          commitment: selectedNft?.commitment,
        });
        if (!nftUtxo?.token?.nft) {
          setError('No NFT found in this category.');
          setMode('error');
          return;
        }

        const outputs: TransactionOutput[] = [
          {
            recipientAddress: recipient,
            amount: 546, // dust for NFT output
            token: {
              category: selectedCategory,
              nft: {
                capability: nftUtxo.token.nft.capability,
                commitment: nftUtxo.token.nft.commitment,
              },
            } as any,
          },
        ];

        const attempt = await growBchForFees(outputs, [nftUtxo]);
        if (!attempt.ok) {
          setError(attempt.err || 'Failed to prepare NFT transaction.');
          setMode('error');
          return;
        }

        setSelectedForTx(attempt.inputs);
        setReview({
          rawTx: attempt.rawTx,
          feeSats: attempt.feeSats,
          totalSats: attempt.feeSats, // BCH spent == fee only
          finalOutputs: attempt.finalOutputs,
        });
        setMode('review');
        return;
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to prepare transaction.');
      setMode('error');
    }
    // deps:
  }, [
    assetType,
    recipient,
    amountBch,
    selectedCategory,
    tokenAmount,
    selectedNft,
    selectedChangeAddress,
    bchUtxos,
    tokenUtxos,
  ]);

  const doSend = useCallback(async () => {
    if (!review?.rawTx) return;
    try {
      setMode('sending');
      const { txid: sentId, errorMessage } =
        await TransactionService.sendTransaction(review.rawTx, selectedForTx);
      if (errorMessage) throw new Error(errorMessage);
      if (!sentId) throw new Error('Broadcast failed with no txid returned.');
      setTxid(sentId);
      setMode('sent');
    } catch (e: any) {
      setError(e?.message || 'Failed to send transaction.');
      setMode('error');
    }
  }, [review, selectedForTx]);

  const fiatSummary = useMemo(() => {
    // Only BCH spend is fee in token cases
    const feeBch = (review?.feeSats ?? 0) / SATSINBITCOIN;
    const nSats = assetType === 'bch' ? Number(amountBch) * SATSINBITCOIN : 0;
    const totalBch =
      assetType === 'bch' ? (review?.totalSats ?? 0) / SATSINBITCOIN : feeBch;

    return {
      amountUsd:
        assetType === 'bch' && prices['BCH']
          ? Number(amountBch || 0) * Number(prices['BCH'])
          : 0,
      feeUsd: prices['BCH'] ? feeBch * Number(prices['BCH']) : 0,
      totalUsd: prices['BCH'] ? totalBch * Number(prices['BCH']) : 0,
    };
  }, [assetType, amountBch, review, prices]);

  return {
    // form
    assetType,
    setAssetType,
    recipient,
    setRecipient,
    amountBch,
    setAmountBch,

    // tokens
    tokenCategories,
    selectedCategory,
    setSelectedCategory,
    tokenAmount,
    setTokenAmount,
    availableNfts,
    selectedNft,
    setSelectedNft,

    // wallet/meta
    currentNetwork,
    addresses,
    defaultChangeAddress,
    selectedChangeAddress,
    setSelectedChangeAddress,

    // flow
    mode,
    error,
    review,
    txid,

    // actions
    reset,
    doReview,
    doSend,

    // display
    fiatSummary,

    // debug
    selectedForTx,
  };
}
