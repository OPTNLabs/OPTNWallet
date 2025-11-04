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
  selectNftInput,
  selectTokenFtInputs,
} from '../services/CoinSelectionService';
import AddressManager from '../apis/AddressManager/AddressManager';

type ReviewState = {
  rawTx: string;
  feeSats: number;
  totalSats: number;
  finalOutputs: TransactionOutput[];
  tokenChange?: {
    category: string;
    amount: bigint;
  };
};

type SimpleSendMode = 'idle' | 'review' | 'sending' | 'sent' | 'error';
type AssetType = 'bch' | 'ft' | 'nft';

// Token output policy: send at least 1,000 sats with token-bearing outputs
const TOKEN_OUTPUT_SATS = 1000;

// Extra BCH fee buffer (BCH change must be at least this, separate from tokens)
const FEE_BUFFER_SATS = 1000;

export default function useSimpleSend() {
  // Redux
  const prices = useSelector((s: RootState) => s.priceFeed);
  const walletId = useSelector(selectWalletId);
  const currentNetwork = useSelector((s: RootState) => selectCurrentNetwork(s));

  // Wallet addresses + default change (also gives tokenAddress mapping)
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

  // DB-backed UTXOs across whole wallet
  const [dbUtxos, setDbUtxos] = useState<UTXO[]>([]);
  const [tokenUtxos, setTokenUtxos] = useState<UTXO[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!walletId) return;
      const { allUtxos, tokenUtxos } =
        await UTXOService.fetchAllWalletUtxos(walletId);
      if (!cancelled) {
        setDbUtxos(allUtxos); // BCH-only UTXOs (or those w/out tokens)
        setTokenUtxos(tokenUtxos || []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [walletId, addresses.length]);

  // BCH change address (P2PKH cashaddr as selected)
  const [selectedChangeAddress, setSelectedChangeAddress] =
    useState<string>('');
  useEffect(() => {
    if (!selectedChangeAddress) {
      setSelectedChangeAddress(
        defaultChangeAddress || addresses[0]?.address || ''
      );
    }
  }, [defaultChangeAddress, addresses, selectedChangeAddress]);

  // Token-aware change address (for FT/NFT change outputs)
  const [tokenChangeAddress, setTokenChangeAddress] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!selectedChangeAddress || !walletId) {
          setTokenChangeAddress(selectedChangeAddress || '');
          return;
        }
        const mgr = AddressManager();
        const tokenAddr = await mgr.fetchTokenAddress(
          Number(walletId as any),
          selectedChangeAddress
        );
        if (!cancelled)
          setTokenChangeAddress(tokenAddr || selectedChangeAddress);
      } catch {
        if (!cancelled) setTokenChangeAddress(selectedChangeAddress || '');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [walletId, selectedChangeAddress]);

  // Form – shared
  const [recipient, setRecipient] = useState<string>('');
  const [assetType, setAssetType] = useState<AssetType>('bch');

  // Form – BCH
  const [amountBch, setAmountBch] = useState<string>('');

  // Form – FT
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [amountToken, setAmountToken] = useState<string>(''); // integer string

  // Form – NFT
  const [selectedNftCommitment, setSelectedNftCommitment] =
    useState<string>('');

  // Flow
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
    setAssetType('bch');
    setAmountBch('');
    setSelectedCategory('');
    setAmountToken('');
    setSelectedNftCommitment('');
  }, []);

  const validateRecipient = (addr: string) =>
    typeof addr === 'string' && addr.trim().length > 10;

  const parseAmountToSats = (val: string): number => {
    const n = Number(val);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n * SATSINBITCOIN);
  };

  // helpers
  function isConfirmed(u: UTXO) {
    return typeof u.height === 'number' && u.height > 0;
  }
  function sortLargestFirst(pool: UTXO[]) {
    return [...pool].sort((a, b) =>
      Number(BigInt(b.amount ?? b.value) - BigInt(a.amount ?? a.value))
    );
  }

  // ----- Token outputs (use 1,000 sats) -----
  function makeTokenOutputForRecipientFT(): TransactionOutput {
    return {
      recipientAddress: recipient,
      amount: TOKEN_OUTPUT_SATS,
      token: {
        category: selectedCategory,
        amount: BigInt(amountToken || '0'),
      },
    };
  }

  function makeTokenChangeOutputFT(remaining: bigint): TransactionOutput {
    return {
      recipientAddress: tokenChangeAddress || selectedChangeAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: {
        category: selectedCategory,
        amount: remaining,
      },
    };
  }

  function makeTokenOutputForRecipientNFT(nftUtxo: UTXO): TransactionOutput {
    return {
      recipientAddress: recipient,
      amount: TOKEN_OUTPUT_SATS,
      token: {
        category: nftUtxo.token!.category,
        amount: 0n, // ✅ NFT outputs still include amount field (zero)
        nft: {
          capability: nftUtxo.token!.nft!.capability,
          commitment: nftUtxo.token!.nft!.commitment,
        },
      },
    };
  }

  function sumInputsSats(inputs: UTXO[]) {
    return inputs.reduce((s, u) => s + Number(u.amount ?? u.value ?? 0), 0);
  }

  /**
   * Attempt a build with given inputs & outputs.
   * Returns fee (1 sat/byte), totalSats (outputs+fee), and computed change (BCH).
   */
  async function tryBuild(
    inputs: UTXO[],
    outputs: TransactionOutput[]
  ): Promise<
    | {
        ok: true;
        feeSats: number;
        totalSats: number;
        rawTx: string;
        finalOutputs: TransactionOutput[];
        changeSats: number;
        inputSum: number;
      }
    | { ok: false; err: string }
  > {
    try {
      const r = await TransactionService.buildTransaction(
        outputs,
        null,
        selectedChangeAddress, // BCH change goes here (cashaddr)
        inputs
      );
      if (r.errorMsg) return { ok: false, err: r.errorMsg };

      const feeSats = r.bytecodeSize; // 1 sat/byte fee policy
      const outputsTotal = outputs
        .map((o) => Number(o.amount || 0))
        .reduce((a, b) => a + b, 0);
      const totalSats = outputsTotal + feeSats;
      const inputSum = sumInputsSats(inputs);
      const changeSats = inputSum - totalSats;

      return {
        ok: true,
        feeSats,
        totalSats,
        rawTx: r.finalTransaction,
        finalOutputs: r.finalOutputs ?? outputs,
        changeSats,
        inputSum,
      };
    } catch (e: any) {
      return { ok: false, err: e?.message || 'build failed' };
    }
  }

  /**
   * Keep token inputs fixed; keep adding BCH inputs (confirmed → then include unconfirmed)
   * until the builder succeeds AND we have at least FEE_BUFFER_SATS in BCH change.
   * Token outputs are already balanced (inputs == outputs) via explicit manual calc.
   */
  async function addBchInputsUntilBuild(
    fixedTokenInputs: UTXO[],
    outputs: TransactionOutput[],
    maxInputs = 50
  ) {
    const confirmedPool = sortLargestFirst(dbUtxos.filter(isConfirmed));
    const unconfirmedPool = sortLargestFirst(
      dbUtxos.filter((u) => !isConfirmed(u))
    );

    // Pass 1: confirmed only
    for (let k = 0; k <= Math.min(maxInputs, confirmedPool.length); k++) {
      const bchInputs = confirmedPool.slice(0, k);
      const inputs = [...fixedTokenInputs, ...bchInputs] as UTXO[];
      const res = await tryBuild(inputs, outputs);
      if ('ok' in res && res.ok) {
        if (res.changeSats >= FEE_BUFFER_SATS) {
          return { ...res, inputs };
        }
      }
    }

    // Pass 2: include unconfirmed
    const combinedPool = sortLargestFirst([
      ...confirmedPool,
      ...unconfirmedPool,
    ]);
    for (let k = 0; k <= Math.min(maxInputs, combinedPool.length); k++) {
      const bchInputs = combinedPool.slice(0, k);
      const inputs = [...fixedTokenInputs, ...bchInputs] as UTXO[];
      const res = await tryBuild(inputs, outputs);
      if ('ok' in res && res.ok) {
        if (res.changeSats >= FEE_BUFFER_SATS) {
          return { ...res, inputs };
        }
      }
    }

    return {
      ok: false as const,
      err: 'Unable to cover 1 sat/byte fee plus buffer. Add more BCH or lower the amount.',
    };
  }

  /**
   * BCH-only flow: add BCH inputs until build succeeds and BCH change ≥ buffer.
   */
  async function addBchOnlyUntilBuild(
    targetSats: number,
    maxInputs = 50
  ): Promise<
    | {
        ok: true;
        inputs: UTXO[];
        feeSats: number;
        totalSats: number;
        rawTx: string;
        finalOutputs: TransactionOutput[];
      }
    | { ok: false; err: string }
  > {
    const confirmedPool = sortLargestFirst(dbUtxos.filter(isConfirmed));
    const unconfirmedPool = sortLargestFirst(
      dbUtxos.filter((u) => !isConfirmed(u))
    );

    const outputs: TransactionOutput[] = [
      { recipientAddress: recipient, amount: targetSats },
    ];

    // Pass 1: confirmed-only
    for (let k = 1; k <= Math.min(maxInputs, confirmedPool.length); k++) {
      const inputs = confirmedPool.slice(0, k);
      const res = await tryBuild(inputs, outputs);
      if ('ok' in res && res.ok) {
        if (res.changeSats >= FEE_BUFFER_SATS) {
          return { ok: true, inputs, ...res };
        }
      }
    }

    // Pass 2: include unconfirmed
    const combined = sortLargestFirst([...confirmedPool, ...unconfirmedPool]);
    for (let k = 1; k <= Math.min(maxInputs, combined.length); k++) {
      const inputs = combined.slice(0, k);
      const res = await tryBuild(inputs, outputs);
      if ('ok' in res && res.ok) {
        if (res.changeSats >= FEE_BUFFER_SATS) {
          return { ok: true, inputs, ...res };
        }
      }
    }

    return {
      ok: false,
      err: 'Insufficient funds: can’t cover amount, 1 sat/byte fee, and 1000-sat buffer.',
    };
  }

  const doReview = useCallback(async () => {
    try {
      setError('');

      if (!validateRecipient(recipient)) {
        setError('Please enter a valid destination address.');
        setMode('error');
        return;
      }
      if (!selectedChangeAddress) {
        setError('Please choose a change address.');
        setMode('error');
        return;
      }

      // ===== BCH =====
      if (assetType === 'bch') {
        const targetSats = parseAmountToSats(amountBch);
        if (targetSats <= 0) {
          setError('Amount must be greater than 0.');
          setMode('error');
          return;
        }

        const attempt = await addBchOnlyUntilBuild(targetSats, 50);
        if (!attempt.ok) {
          setError('err' in attempt ? attempt.err : 'Build failed.');
          setMode('error');
          return;
        }

        setSelectedForTx(attempt.inputs);
        setReview({
          rawTx: attempt.rawTx,
          feeSats: attempt.feeSats,
          totalSats: attempt.totalSats,
          finalOutputs: attempt.finalOutputs,
        });
        setMode('review');
        return;
      }

      // From here: token sends also need BCH for fees
      if (!dbUtxos.length) {
        setError('No BCH UTXOs available to cover fees.');
        setMode('error');
        return;
      }

      // ===== FT (single category) =====
      if (assetType === 'ft') {
        if (!selectedCategory) {
          setError('Select a token category.');
          setMode('error');
          return;
        }
        const tokAmt = BigInt(amountToken || '0');
        if (tokAmt <= 0n) {
          setError('Enter a positive token amount.');
          setMode('error');
          return;
        }

        const { tokenInputs } = selectTokenFtInputs(
          selectedCategory,
          tokenUtxos,
          tokAmt,
          { preferConfirmed: true, maxInputs: 100 }
        );
        if (!tokenInputs.length) {
          setError('No token UTXOs available for the selected category.');
          setMode('error');
          return;
        }

        // Manual FT remainder calculation over chosen inputs
        const totalFromInputs = tokenInputs.reduce((sum, u) => {
          const amt =
            u.token?.category === selectedCategory
              ? BigInt(u.token?.amount ?? 0)
              : 0n;
          return sum + amt;
        }, 0n);

        if (totalFromInputs < tokAmt) {
          setError('Insufficient token balance for this category.');
          setMode('error');
          return;
        }

        const changeTok = totalFromInputs - tokAmt;

        const outputs: TransactionOutput[] = [makeTokenOutputForRecipientFT()];
        if (changeTok > 0n) {
          outputs.push(makeTokenChangeOutputFT(changeTok));
        }

        // Fixed token inputs; add BCH until fee+buffer are covered (BCH change only).
        const built = await addBchInputsUntilBuild(tokenInputs, outputs, 100);
        if (!('ok' in built) || !built.ok) {
          setError(
            'err' in built
              ? built.err
              : 'Failed to prepare token transaction (fees).'
          );
          setMode('error');
          return;
        }

        setSelectedForTx(built.inputs);
        setReview({
          rawTx: built.rawTx,
          feeSats: built.feeSats,
          totalSats: built.totalSats,
          finalOutputs: built.finalOutputs,
          tokenChange:
            changeTok > 0n
              ? { category: selectedCategory, amount: changeTok }
              : undefined,
        });
        setMode('review');
        return;
      }

      // ===== NFT (single UTXO) =====
      if (assetType === 'nft') {
        if (!selectedCategory) {
          setError('Select an NFT category.');
          setMode('error');
          return;
        }
        const nftInput = selectNftInput(selectedCategory, tokenUtxos, {
          preferConfirmed: true,
          commitmentHex: selectedNftCommitment || undefined,
        });
        if (!nftInput) {
          setError('No NFT UTXO found for this category/commitment.');
          setMode('error');
          return;
        }

        const outputs: TransactionOutput[] = [
          makeTokenOutputForRecipientNFT(nftInput),
        ];

        // Fixed NFT input; add BCH until fee+buffer are covered (BCH change only).
        const built = await addBchInputsUntilBuild([nftInput], outputs, 100);
        if (!('ok' in built) || !built.ok) {
          setError(
            'err' in built
              ? built.err
              : 'Failed to prepare NFT transaction (fees).'
          );
          setMode('error');
          return;
        }

        setSelectedForTx(built.inputs);
        setReview({
          rawTx: built.rawTx,
          feeSats: built.feeSats,
          totalSats: built.totalSats,
          finalOutputs: built.finalOutputs,
          tokenChange: undefined, // NFTs have no "change"
        });
        setMode('review');
        return;
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to prepare transaction.');
      setMode('error');
    }
  }, [
    recipient,
    amountBch,
    assetType,
    selectedCategory,
    amountToken,
    selectedNftCommitment,
    dbUtxos,
    tokenUtxos,
    selectedChangeAddress,
    tokenChangeAddress,
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

  // derive token metadata (categories with totals & NFT commitments)
  const categories = useMemo(() => {
    const set = new Map<
      string,
      { isNft: boolean; ftAmount: bigint; nftCommitments: string[] }
    >();
    for (const u of tokenUtxos) {
      const cat = u.token?.category;
      if (!cat) continue;
      const rec = set.get(cat) || {
        isNft: false,
        ftAmount: 0n,
        nftCommitments: [],
      };
      if (u.token?.nft) {
        rec.isNft = true;
        const c = (u.token.nft.commitment || '').toLowerCase();
        if (c && !rec.nftCommitments.includes(c)) rec.nftCommitments.push(c);
      } else {
        rec.ftAmount += BigInt(u.token?.amount ?? 0);
      }
      set.set(cat, rec);
    }
    return Array.from(set.entries()).map(([category, info]) => ({
      category,
      ...info,
    }));
  }, [tokenUtxos]);

  const fiatSummary = useMemo(() => {
    const nSats = assetType === 'bch' ? parseAmountToSats(amountBch) : 0;
    const amountBchNum = nSats / SATSINBITCOIN;
    const feeBch = (review?.feeSats ?? 0) / SATSINBITCOIN;
    const totalBch = (review?.totalSats ?? 0) / SATSINBITCOIN;

    return {
      amountUsd: priceUsd ? amountBchNum * priceUsd : 0,
      feeUsd: priceUsd ? feeBch * priceUsd : 0,
      totalUsd: priceUsd ? totalBch * priceUsd : 0,
    };
  }, [amountBch, assetType, review, priceUsd]);

  return {
    // form
    recipient,
    setRecipient,

    // asset
    assetType,
    setAssetType,

    // BCH
    amountBch,
    setAmountBch,

    // token
    selectedCategory,
    setSelectedCategory,
    amountToken,
    setAmountToken,
    selectedNftCommitment,
    setSelectedNftCommitment,

    // wallet/meta
    currentNetwork,
    addresses,
    defaultChangeAddress,
    selectedChangeAddress,
    setSelectedChangeAddress,

    // expose token-aware change for the UI
    tokenChangeAddress,

    categories,

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
