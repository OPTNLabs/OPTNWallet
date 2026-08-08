// src/hooks/useSimpleSend.ts

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { RootState } from '../state/store';
import {
  selectWalletId,
  selectWalletType,
} from '../state/slices/walletSlice';
import useFetchWalletAddresses from './useFetchWalletAddresses';
import { signHardwarePayment } from '../services/hardware/hardwareSignTransaction';

import { UTXO } from '../types/types';
import TransactionService, {
  type BroadcastState,
} from '../services/TransactionService';
import { selectCurrentNetwork } from '../state/selectors/networkSelectors';
import { SATSINBITCOIN } from '../utils/constants';
import UTXOService from '../services/UTXOService';
import { outpointKey } from '../platform/desktop/CoinLabelService';
import { applySpendOnlyFusedPolicy } from '../platform/desktop/fusionSpendPolicy';
import { selectSpendOnlyFusedCoins } from '../state/slices/experimentalSlice';
import {
  selectNftInput,
  selectTokenFtInputs,
} from '../services/CoinSelectionService';
import AddressManager from '../apis/AddressManager/AddressManager';
import { toErrorMessage } from '../utils/errorHandling';
import {
  normalizeDecimalInput,
  parseAmountToSats,
  parseDecimalAmountToAtomic,
  resolveTokenDecimalsByCategory,
  validateRecipient,
} from './simple-send/helpers';
import { createSimpleSendPlanner } from './simple-send/planner';
import { AssetType, ReviewState, SimpleSendMode } from './simple-send/types';
import { parseBip21Uri } from '../utils/bip21';
import {
  getLegacyDefaultChangeAddress,
  getPreferredBchChangeAddress,
} from '../utils/changeAddressPreference';
import { getRpaSendBlockReason } from '../services/RpaService';

export default function useSimpleSend() {
  // Redux
  const prices = useSelector((s: RootState) => s.priceFeed);
  const walletId = useSelector(selectWalletId);
  const walletType = useSelector(selectWalletType);
  const isHardwareWallet = walletType === 'hardware';
  const currentNetwork = useSelector((s: RootState) => selectCurrentNetwork(s));
  const spendOnlyFusedCoins = useSelector(selectSpendOnlyFusedCoins);
  const preferInternalChangeForBch = false;

  // Wallet addresses + default change (also gives tokenAddress mapping)
  const [addresses, setAddresses] = useState<
    { address: string; tokenAddress: string }[]
  >([]);
  const [defaultChangeAddress, setDefaultChangeAddress] = useState<string>('');
  const [preferredBchChangeAddress, setPreferredBchChangeAddress] =
    useState<string>('');
  const [error, setError] = useState<string>('');
  const [assetType, setAssetType] = useState<AssetType>('bch');
  const [hydrated, setHydrated] = useState(false);
  const [maxBusy, setMaxBusy] = useState(false);
  /** True while Review is building a tx (keeps the button responsive / labeled). */
  const [reviewBusy, setReviewBusy] = useState(false);
  /** Live status while hardware signs (Ledger shows screens — user must press buttons). */
  const [sendStatus, setSendStatus] = useState('');
  const reviewInFlightRef = useRef(false);

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => setHydrated(true));
    return () => window.cancelAnimationFrame(raf);
  }, []);

  const setErrorMessage = useCallback(
    (value: string | null) => setError(value ?? ''),
    []
  );

  useFetchWalletAddresses(
    hydrated ? walletId : null,
    setAddresses,
    setDefaultChangeAddress,
    setErrorMessage
  );

  // DB-backed UTXOs across whole wallet
  const [dbUtxos, setDbUtxos] = useState<UTXO[]>([]);
  const [tokenUtxos, setTokenUtxos] = useState<UTXO[]>([]);
  /** Global coin control on Simple Send: restrict spend pool to checked coins. */
  const [coinControlEnabled, setCoinControlEnabled] = useState(false);
  const [selectedCoinKeys, setSelectedCoinKeys] = useState<Set<string>>(
    () => new Set()
  );

  const applyCoinControl = useCallback(
    (pool: UTXO[]): UTXO[] | { error: string } => {
      let next = pool;
      if (coinControlEnabled) {
        if (selectedCoinKeys.size === 0) {
          return {
            error:
              'Coin control is on but no coins are selected. Check at least one coin, or turn Manual off.',
          };
        }
        next = pool.filter((u) =>
          selectedCoinKeys.has(outpointKey(u.tx_hash, u.tx_pos))
        );
        if (next.length === 0) {
          return {
            error:
              'None of the selected coins are available. Refresh the wallet or update coin control.',
          };
        }
      }
      return applySpendOnlyFusedPolicy(walletId, next, spendOnlyFusedCoins);
    },
    [coinControlEnabled, selectedCoinKeys, walletId, spendOnlyFusedCoins]
  );
  useEffect(() => {
    if (!hydrated) return;
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
  }, [walletId, addresses.length, hydrated]);

  // The worker normally keeps the SQL.js snapshot current, but each Tauri
  // process has its own in-memory database. A full listunspent over every
  // address is authoritative for multi-window freshness, but it is also the
  // slow path (many addresses / Tor / Electrum). Review must not block the UI
  // on that sweep — use the local snapshot when present (same as Max / token
  // fee pool) and only force a network refresh when we have nothing to spend.
  // The service also reconstructs pending owned outputs from the shared
  // outbound tracker, so unconfirmed change remains spendable after a refresh.
  const refreshBchUtxos = useCallback(async (): Promise<UTXO[]> => {
    if (!walletId) return [];

    const walletAddresses = addresses
      .map(({ address }) => address)
      .filter(Boolean);
    if (walletAddresses.length > 0) {
      await UTXOService.fetchAndStoreUTXOsMany(walletId, walletAddresses, {
        // Discovery belongs to the worker/bootstrap path. Spending should
        // refresh the known address set without waiting on history probes.
        discover: false,
      });
    }

    const { allUtxos } = await UTXOService.fetchAllWalletUtxos(walletId);
    const refreshed = (allUtxos ?? []).filter((utxo) => !utxo.token);
    setDbUtxos(refreshed);
    return refreshed;
  }, [walletId, addresses]);

  /**
   * Spendable BCH pool for Review/Max-style builds.
   * Prefer the already-loaded snapshot so the button feels instant; kick a
   * background network refresh so the next action sees fresher coins without
   * freezing this click. Only await the network path when the pool is empty.
   */
  const loadSpendableBchUtxos = useCallback(async (): Promise<UTXO[]> => {
    if (dbUtxos.length > 0) {
      void refreshBchUtxos().catch(() => undefined);
      return dbUtxos;
    }
    return await refreshBchUtxos();
  }, [dbUtxos, refreshBchUtxos]);

  // BCH change address (P2PKH cashaddr as selected)
  const [selectedChangeAddress, setSelectedChangeAddressState] =
    useState<string>('');
  const [hasManualChangeSelection, setHasManualChangeSelection] =
    useState(false);
  const setSelectedChangeAddress = useCallback((address: string) => {
    setHasManualChangeSelection(true);
    setSelectedChangeAddressState(address);
  }, []);

  useEffect(() => {
    setHasManualChangeSelection(false);
    setSelectedChangeAddressState('');
    setPreferredBchChangeAddress('');
  }, [walletId]);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    (async () => {
      if (!walletId) {
        if (!cancelled) setPreferredBchChangeAddress('');
        return;
      }

      if (!preferInternalChangeForBch) {
        if (!cancelled) {
          setPreferredBchChangeAddress(getLegacyDefaultChangeAddress(addresses));
        }
        return;
      }

      try {
        const preferred = await getPreferredBchChangeAddress(walletId, addresses);
        if (!cancelled) setPreferredBchChangeAddress(preferred);
      } catch {
        if (!cancelled) {
          setPreferredBchChangeAddress(getLegacyDefaultChangeAddress(addresses));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [walletId, addresses, preferInternalChangeForBch, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    if (hasManualChangeSelection) return;

    const legacyDefault =
      defaultChangeAddress || getLegacyDefaultChangeAddress(addresses);
    const nextDefault =
      assetType === 'bch' && preferInternalChangeForBch
        ? preferredBchChangeAddress || legacyDefault
        : legacyDefault;

    if (selectedChangeAddress !== nextDefault) {
      setSelectedChangeAddressState(nextDefault);
    }
  }, [
    assetType,
    defaultChangeAddress,
    addresses,
    hasManualChangeSelection,
    preferInternalChangeForBch,
    preferredBchChangeAddress,
    selectedChangeAddress,
    hydrated,
  ]);

  // Token-aware change address (for FT/NFT change outputs)
  const [tokenChangeAddress, setTokenChangeAddress] = useState<string>('');
  useEffect(() => {
    if (!hydrated) return;
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
  }, [walletId, selectedChangeAddress, hydrated]);

  // Form – shared
  const [recipient, setRecipient] = useState<string>('');

  // Form – FT
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [amountTokenState, setAmountTokenState] = useState<string>('');

  // Form – NFT
  const [selectedNftCommitment, setSelectedNftCommitment] =
    useState<string>('');
  const [amountDisplayMode, setAmountDisplayModeState] =
    useState<'bch' | 'usd'>('bch');
  const [amountBchState, setAmountBchState] = useState<string>('');
  const [amountUsdState, setAmountUsdState] = useState<string>('');

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

  const bchUsdPrice = prices['BCH-USD']?.price ?? 0;

  const formatUsdFromBch = useCallback(
    (bchValue: string) => {
      if (!bchUsdPrice) return '';
      const sats = parseAmountToSats(bchValue);
      if (sats <= 0) return '';
      return ((sats / SATSINBITCOIN) * bchUsdPrice).toFixed(2);
    },
    [bchUsdPrice]
  );

  const formatBchFromUsd = useCallback(
    (usdValue: string) => {
      if (!bchUsdPrice) return '';
      const usd = Number(usdValue);
      if (!Number.isFinite(usd) || usd <= 0) return '';
      const sats = Math.round((usd / bchUsdPrice) * SATSINBITCOIN);
      if (sats <= 0) return '';
      return (sats / SATSINBITCOIN).toFixed(8);
    },
    [bchUsdPrice]
  );

  const amountBch = amountBchState;
  const amountUsd = amountUsdState;
  const amountToken = amountTokenState;
  const tokenDecimalsByCategory = useMemo(
    () => resolveTokenDecimalsByCategory(tokenUtxos),
    [tokenUtxos]
  );
  const selectedTokenDecimals = tokenDecimalsByCategory[selectedCategory] ?? 0;

  const setAmountBch = useCallback(
    (nextValue: string) => {
      const normalized = normalizeDecimalInput(nextValue, 8);
      setAmountBchState(normalized);
      setAmountUsdState(formatUsdFromBch(normalized));
    },
    [formatUsdFromBch]
  );

  const setAmountUsd = useCallback(
    (nextValue: string) => {
      const normalized = normalizeDecimalInput(nextValue, 2);
      setAmountUsdState(normalized);
      setAmountBchState(formatBchFromUsd(normalized));
    },
    [formatBchFromUsd]
  );

  const setAmountToken = useCallback(
    (nextValue: string) => {
      setAmountTokenState(normalizeDecimalInput(nextValue, selectedTokenDecimals));
    },
    [selectedTokenDecimals]
  );

  useEffect(() => {
    setAmountTokenState((current) =>
      normalizeDecimalInput(current, selectedTokenDecimals)
    );
  }, [selectedTokenDecimals]);

  const setAmountDisplayMode = useCallback(
    (nextMode: 'bch' | 'usd') => {
      setAmountDisplayModeState(nextMode);
      if (nextMode === 'usd') {
        setAmountUsdState(formatUsdFromBch(amountBch));
      } else {
        setAmountBchState(formatBchFromUsd(amountUsd));
      }
    },
    [amountBch, amountUsd, formatBchFromUsd, formatUsdFromBch]
  );

  useEffect(() => {
    if (!bchUsdPrice) return;

    if (amountDisplayMode === 'bch') {
      const nextUsd = formatUsdFromBch(amountBch);
      if (nextUsd !== amountUsd) {
        setAmountUsdState(nextUsd);
      }
      return;
    }

    const nextBch = formatBchFromUsd(amountUsd);
    if (nextBch !== amountBch) {
      setAmountBchState(nextBch);
    }
  }, [
    amountBch,
    amountDisplayMode,
    amountUsd,
    bchUsdPrice,
    formatBchFromUsd,
    formatUsdFromBch,
  ]);

  const reset = useCallback(() => {
    setMode('idle');
    setError('');
    setReview(null);
    setSelectedForTx([]);
    setTxid('');
    setBroadcastState('broadcasted');
    setAssetType('bch');
    setAmountBchState('');
    setAmountUsdState('');
    setAmountDisplayModeState('bch');
    setSelectedCategory('');
    setAmountToken('');
    setSelectedNftCommitment('');
    setCoinControlEnabled(false);
    setSelectedCoinKeys(new Set());
    setReviewBusy(false);
    reviewInFlightRef.current = false;
  }, [setAmountToken]);

  const doReview = useCallback(async () => {
    if (reviewInFlightRef.current) return;
    reviewInFlightRef.current = true;
    setReviewBusy(true);
    setError('');
    // Yield so React can paint "Preparing…" before build work.
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
    try {
      const rpaBlockReason = getRpaSendBlockReason(recipient, currentNetwork);
      if (rpaBlockReason) {
        setError(rpaBlockReason);
        setMode('error');
        return;
      }

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

        // Local snapshot first (Max-style). Full Electrum refresh no longer
        // blocks this click — it runs in the background via loadSpendableBchUtxos.
        const freshDbUtxos = await loadSpendableBchUtxos();
        const controlled = applyCoinControl(freshDbUtxos);
        if ('error' in controlled) {
          setError(controlled.error);
          setMode('error');
          return;
        }
        const freshPlanner = createSimpleSendPlanner({
          recipient: normalizedRecipient,
          selectedCategory,
          amountToken,
          tokenChangeAddress,
          selectedChangeAddress,
          dbUtxos: controlled,
          hardwareWallet: isHardwareWallet,
        });
        const attempt = await freshPlanner.addBchOnlyUntilBuild(targetSats, 50);
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
      const feePoolRaw = await loadSpendableBchUtxos();
      const feePool = applyCoinControl(feePoolRaw);
      if ('error' in feePool) {
        setError(feePool.error);
        setMode('error');
        return;
      }
      if (!feePool.length) {
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
        const tokAmt = parseDecimalAmountToAtomic(
          amountToken,
          selectedTokenDecimals
        );
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

        const feePlanner = createSimpleSendPlanner({
          recipient: normalizedRecipient,
          selectedCategory,
          amountToken,
          tokenChangeAddress,
          selectedChangeAddress,
          dbUtxos: feePool,
        });
        const outputs = [feePlanner.makeTokenOutputForRecipientFT()];
        if (changeTok > 0n) {
          outputs.push(feePlanner.makeTokenChangeOutputFT(changeTok));
        }

        // Fixed token inputs; add BCH until fee+buffer are covered (BCH change only).
        const built = await feePlanner.addBchInputsUntilBuild(
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

        const feePlanner = createSimpleSendPlanner({
          recipient: normalizedRecipient,
          selectedCategory,
          amountToken,
          tokenChangeAddress,
          selectedChangeAddress,
          dbUtxos: feePool,
        });
        const outputs = [
          feePlanner.makeTokenOutputForRecipientNFT(nftInput),
        ];

        // Fixed NFT input; add BCH until fee+buffer are covered (BCH change only).
        const built = await feePlanner.addBchInputsUntilBuild(
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
    } finally {
      reviewInFlightRef.current = false;
      setReviewBusy(false);
    }
  }, [
    normalizedRecipient,
    recipient,
    currentNetwork,
    amountBch,
    assetType,
    selectedCategory,
    amountToken,
    selectedTokenDecimals,
    selectedNftCommitment,
    tokenUtxos,
    selectedChangeAddress,
    parsedRecipient.amountRaw,
    loadSpendableBchUtxos,
    tokenChangeAddress,
    applyCoinControl,
    isHardwareWallet,
  ]);

  // "Max": fills the BCH amount field with the full spendable balance minus
  // network fee. Only fills the field — the user still reviews and confirms
  // the send through the normal doReview/doSend flow, so no new send path is
  // introduced. BCH-only (token/NFT "max" is a separate, per-category concept
  // not covered here).
  const doMax = useCallback(async () => {
    if (assetType !== 'bch' || maxBusy) return;
    const rpaBlockReason = getRpaSendBlockReason(recipient, currentNetwork);
    if (rpaBlockReason) {
      setError(rpaBlockReason);
      setMode('error');
      return;
    }
    if (!validateRecipient(normalizedRecipient)) {
      setError('Enter a valid destination address first.');
      setMode('error');
      return;
    }
    if (!selectedChangeAddress) {
      setError('Change address is still loading. Try again in a moment.');
      setMode('error');
      return;
    }

    setMaxBusy(true);
    setError('');
    try {
      // The amount field is a preview. Use the already-loaded wallet snapshot
      // so Max is responsive; doReview performs the authoritative refresh
      // immediately before transaction construction.
      const freshDbUtxos =
        dbUtxos.length > 0 ? dbUtxos : await refreshBchUtxos();
      const controlled = applyCoinControl(freshDbUtxos);
      if ('error' in controlled) {
        setError(controlled.error);
        setMode('error');
        return;
      }
      const freshPlanner = createSimpleSendPlanner({
        recipient: normalizedRecipient,
        selectedCategory,
        amountToken,
        tokenChangeAddress,
        selectedChangeAddress,
        dbUtxos: controlled,
      });
      const result = await freshPlanner.sweepAllBchUntilBuild(50);
      if (!result.ok) {
        setError(
          'err' in result ? result.err : 'Unable to compute max amount.'
        );
        setMode('error');
        return;
      }
      const maxSats = Number(result.finalOutputs[0]?.amount ?? 0);
      if (!Number.isSafeInteger(maxSats) || maxSats <= 0) {
        throw new Error('The wallet returned an invalid maximum spend amount.');
      }
      setAmountBch((maxSats / SATSINBITCOIN).toFixed(8));
      // setAmountBch already synchronizes the USD mirror. Switching through
      // setAmountDisplayMode here would convert from the stale USD state and
      // overwrite the freshly calculated max amount.
      setAmountDisplayModeState('bch');
    } catch (error: unknown) {
      setError(toErrorMessage(error, 'Unable to compute max amount.'));
      setMode('error');
    } finally {
      setMaxBusy(false);
    }
  }, [
    assetType,
    maxBusy,
    recipient,
    currentNetwork,
    normalizedRecipient,
    amountToken,
    selectedCategory,
    tokenChangeAddress,
    selectedChangeAddress,
    dbUtxos,
    refreshBchUtxos,
    setAmountBch,
    applyCoinControl,
  ]);

  const doSend = useCallback(async () => {
    if (!review) return;
    // Software path needs a signed rawTx from review. Hardware path signs on device now.
    if (!isHardwareWallet && !review.rawTx) return;
    try {
      setMode('sending');
      setSendStatus(
        isHardwareWallet
          ? 'Preparing hardware sign… Look at your Ledger.'
          : 'Broadcasting…'
      );
      let rawHex = review.rawTx;

      if (isHardwareWallet) {
        // Electron Cash: sign_transaction after planning — device produces hex.
        if (!walletId || walletId <= 0) {
          throw new Error('No wallet open for hardware sign.');
        }
        if (!review.finalOutputs?.length) {
          throw new Error('No planned outputs for hardware sign.');
        }
        rawHex = await signHardwarePayment({
          walletId,
          inputs: selectedForTx,
          outputs: review.finalOutputs,
          changeAddress: selectedChangeAddress || undefined,
          onProgress: (_stage, detail) => {
            setSendStatus(
              detail ||
                'Confirm the transaction on your Ledger (both buttons)…'
            );
          },
        });
        setSendStatus('Broadcasting signed transaction…');
      }

      const { txid: sentId, errorMessage, broadcastState: sentState } =
        await TransactionService.sendTransaction(rawHex, selectedForTx, {
          source: 'simple-send',
          sourceLabel: isHardwareWallet ? 'Hardware Send' : 'Simple Send',
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
      setSendStatus('');
      setMode('sent');
    } catch (error: unknown) {
      setError(toErrorMessage(error, 'Failed to send transaction.'));
      setSendStatus('');
      setMode('error');
    }
  }, [
    amountBch,
    amountToken,
    assetType,
    parsedRecipient.amountRaw,
    review,
    normalizedRecipient,
    selectedForTx,
    isHardwareWallet,
    walletId,
    selectedChangeAddress,
  ]);

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
      amountUsd: bchUsdPrice ? amountBchNum * bchUsdPrice : 0,
      feeUsd: bchUsdPrice ? feeBch * bchUsdPrice : 0,
      totalUsd: bchUsdPrice ? totalBch * bchUsdPrice : 0,
    };
  }, [amountBch, assetType, review, bchUsdPrice]);

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
    amountUsd,
    setAmountUsd,
    amountDisplayMode,
    setAmountDisplayMode,
    bchUsdPrice,

    // token
    selectedCategory,
    setSelectedCategory,
    amountToken,
    setAmountToken,
    selectedTokenDecimals,
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
    maxBusy,
    reviewBusy,
    sendStatus,
    isHardwareWallet,

    // coin control (global Simple Send)
    dbUtxos,
    coinControlEnabled,
    setCoinControlEnabled,
    selectedCoinKeys,
    setSelectedCoinKeys,

    // actions
    reset,
    doReview,
    doSend,
    doMax,

    // display
    fiatSummary,

    // debug
    selectedForTx,
  };
}
