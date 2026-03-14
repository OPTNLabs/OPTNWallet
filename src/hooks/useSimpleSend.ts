// src/hooks/useSimpleSend.ts

import {
  Dispatch,
  SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useSelector } from 'react-redux';

import { RootState } from '../redux/store';
import { selectWalletId } from '../redux/walletSlice';
import useFetchWalletData from './useFetchWalletData';

import {
  ContractAddressRecord,
  UTXO,
} from '../types/types';
import TransactionService, {
  type BroadcastState,
} from '../services/TransactionService';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { SATSINBITCOIN } from '../utils/constants';
import UTXOService from '../services/UTXOService';
import {
  selectNftInput,
  selectTokenFtInputs,
} from '../services/CoinSelectionService';
import AddressManager from '../apis/AddressManager/AddressManager';
import { toErrorMessage } from '../utils/errorHandling';
import { parseAmountToSats, validateRecipient } from './simple-send/helpers';
import { createSimpleSendPlanner } from './simple-send/planner';
import { AssetType, ReviewState, SimpleSendMode } from './simple-send/types';
import { parseBip21Uri } from '../utils/bip21';

const noopSetContractAddresses: Dispatch<SetStateAction<ContractAddressRecord[]>> =
  () => undefined;
const noopSetUtxos: Dispatch<SetStateAction<UTXO[]>> = () => undefined;

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

  const setErrorMessage = useCallback(
    (value: string | null) => setError(value ?? ''),
    []
  );

  useFetchWalletData(
    walletId,
    setAddresses,
    noopSetContractAddresses,
    noopSetUtxos,
    noopSetUtxos,
    setDefaultChangeAddress,
    setErrorMessage
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
        setDbUtxos((allUtxos || []).filter((u) => !u.token)); // non-token BCH UTXOs for fee funding
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
          walletId,
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
  const [broadcastState, setBroadcastState] =
    useState<BroadcastState>('broadcasted');
  const parsedRecipient = useMemo(
    () => parseBip21Uri(recipient, currentNetwork),
    [recipient, currentNetwork]
  );
  const normalizedRecipient = parsedRecipient.isValidAddress
    ? parsedRecipient.normalizedAddress
    : recipient;

  const priceUsd = Number(prices['BCH-USD'] || 0);

  const reset = useCallback(() => {
    setMode('idle');
    setError('');
    setReview(null);
    setSelectedForTx([]);
    setTxid('');
    setBroadcastState('broadcasted');
    setAssetType('bch');
    setAmountBch('');
    setSelectedCategory('');
    setAmountToken('');
    setSelectedNftCommitment('');
  }, []);

  const planner = useMemo(
    () =>
      createSimpleSendPlanner({
        recipient: normalizedRecipient,
        selectedCategory,
        amountToken,
        tokenChangeAddress,
        selectedChangeAddress,
        dbUtxos,
      }),
    [
      normalizedRecipient,
      selectedCategory,
      amountToken,
      tokenChangeAddress,
      selectedChangeAddress,
      dbUtxos,
    ]
  );

  const doReview = useCallback(async () => {
    try {
      setError('');

      if (!validateRecipient(normalizedRecipient)) {
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
        const targetSats = parseAmountToSats(amountBch || parsedRecipient.amountRaw || '');
        if (targetSats <= 0) {
          setError('Amount must be greater than 0.');
          setMode('error');
          return;
        }

        const attempt = await planner.addBchOnlyUntilBuild(targetSats, 50);
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
        setError('No non-token BCH UTXOs available to cover fees.');
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
          { preferConfirmed: false, maxInputs: 100 }
        );
        if (!tokenInputs.length) {
          setError('No token UTXOs available for the selected category.');
          setMode('error');
          return;
        }

        // Manual FT remainder calculation over chosen inputs
        const totalFromInputs = tokenInputs.reduce((sum, u) => {
          const amtRaw = u.token?.amount ?? 0;
          const amt =
            typeof amtRaw === 'bigint' ? amtRaw : BigInt(Math.trunc(amtRaw));

          return sum + amt;
        }, 0n);

        if (totalFromInputs < tokAmt) {
          setError('Insufficient token balance for this category.');
          setMode('error');
          return;
        }

        const changeTok = totalFromInputs - tokAmt;

        const outputs = [planner.makeTokenOutputForRecipientFT()];
        if (changeTok > 0n) {
          outputs.push(planner.makeTokenChangeOutputFT(changeTok));
        }

        // Fixed token inputs; add BCH until fee+buffer are covered (BCH change only).
        const built = await planner.addBchInputsUntilBuild(
          tokenInputs,
          outputs,
          100
        );
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
          preferConfirmed: false,
          commitmentHex: selectedNftCommitment || undefined,
        });
        if (!nftInput) {
          setError('No NFT UTXO found for this category/commitment.');
          setMode('error');
          return;
        }

        const outputs = [planner.makeTokenOutputForRecipientNFT(nftInput)];

        // Fixed NFT input; add BCH until fee+buffer are covered (BCH change only).
        const built = await planner.addBchInputsUntilBuild(
          [nftInput],
          outputs,
          100
        );
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
    } catch (error: unknown) {
      setError(toErrorMessage(error, 'Failed to prepare transaction.'));
      setMode('error');
    }
  }, [
    normalizedRecipient,
    amountBch,
    assetType,
    selectedCategory,
    amountToken,
    selectedNftCommitment,
    dbUtxos,
    tokenUtxos,
    selectedChangeAddress,
    parsedRecipient.amountRaw,
    planner,
  ]);

  const doSend = useCallback(async () => {
    if (!review?.rawTx) return;
    try {
      setMode('sending');
      const { txid: sentId, errorMessage, broadcastState: sentState } =
        await TransactionService.sendTransaction(review.rawTx, selectedForTx, {
          source: 'simple-send',
          sourceLabel: 'Simple Send',
          recipientSummary: normalizedRecipient,
          amountSummary:
            assetType === 'bch'
              ? `${amountBch || parsedRecipient.amountRaw || ''} BCH`
              : assetType === 'ft'
                ? `${amountToken} tokens`
                : 'NFT transfer',
        });
      if (errorMessage) throw new Error(errorMessage);
      if (!sentId) throw new Error('Broadcast failed with no txid returned.');
      setTxid(sentId);
      setBroadcastState(sentState ?? 'broadcasted');
      setMode('sent');
    } catch (error: unknown) {
      setError(toErrorMessage(error, 'Failed to send transaction.'));
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
        const amtRaw = u.token?.amount ?? 0;
        const amt =
          typeof amtRaw === 'bigint' ? amtRaw : BigInt(Math.trunc(amtRaw));

        rec.ftAmount += BigInt(amt ?? 0);
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
    broadcastState,

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
