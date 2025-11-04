// src/pages/SimpleSend.tsx

import React, { useMemo, useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import useSimpleSend from '../hooks/useSimpleSend';
import BcmrService from '../services/BcmrService';
import { shortenTxHash } from '../utils/shortenHash';
import { PREFIX } from '../utils/constants';
import Draggable from 'react-draggable';
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import { FaCamera } from 'react-icons/fa';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-sm font-semibold text-emerald-900/90">
      {children}
    </label>
  );
}

function copy(text: string) {
  try {
    navigator.clipboard.writeText(text);
  } catch {}
}

export default function SimpleSend() {
  const {
    recipient,
    setRecipient,

    // asset choice
    assetType,
    setAssetType,

    // BCH
    amountBch,
    setAmountBch,

    // token fields
    selectedCategory,
    setSelectedCategory,
    amountToken,
    setAmountToken,
    selectedNftCommitment,
    setSelectedNftCommitment,

    currentNetwork,
    addresses,
    selectedChangeAddress,
    setSelectedChangeAddress,

    // token-aware change destination (resolved)
    tokenChangeAddress,

    categories,

    mode,
    error,
    review,
    txid,

    reset,
    doReview,
    doSend,

    fiatSummary,

    selectedForTx, // debug
  } = useSimpleSend() as any;

  const isSending = mode === 'sending';
  const [showDebug, setShowDebug] = useState(false);
  const [showInputsJson, setShowInputsJson] = useState(false);
  const [showOutputsJson, setShowOutputsJson] = useState(false);

  // ─────────────────────────────────────────────────────────────
  // Swipe-to-confirm modal state
  // ─────────────────────────────────────────────────────────────
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sliderPos, setSliderPos] = useState({ x: 0, y: 0 });
  const sliderWidth = 240; // track width
  const handleWidth = 48;
  const threshold = sliderWidth * 0.7;

  const openConfirm = () => setConfirmOpen(true);
  const closeConfirm = () => {
    setConfirmOpen(false);
    setSliderPos({ x: 0, y: 0 });
  };

  // Non-async to satisfy DraggableEventHandler (must return void | false)
  const onSwipeStop = (_e: any, data: any) => {
    if (data.x >= threshold && !isSending) {
      doSend()
        .catch(() => {})
        .finally(() => {
          setSliderPos({ x: 0, y: 0 });
          setConfirmOpen(false);
        });
    } else {
      setSliderPos({ x: 0, y: 0 });
    }
  };

  // ─────────────────────────────────────────────────────────────
  // BCMR metadata cache for categories (FT & NFT)
  // ─────────────────────────────────────────────────────────────
  const [tokenMeta, setTokenMeta] = useState<
    Record<string, { name: string; symbol: string; decimals: number }>
  >({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!Array.isArray(categories) || categories.length === 0) return;

      const bcmr = new BcmrService();
      const uniques = Array.from(
        new Set(categories.map((c: any) => c.category))
      );
      const acc: [
        string,
        { name: string; symbol: string; decimals: number },
      ][] = [];

      for (const cat of uniques) {
        try {
          // Prefer snapshot (local), otherwise resolve and retry snapshot
          let snap = await bcmr.getSnapshot(cat);
          if (!snap) {
            try {
              await bcmr.resolveIdentityRegistry(cat);
              snap = await bcmr.getSnapshot(cat);
            } catch {
              // ignore individual failures
            }
          }
          if (snap) {
            acc.push([
              cat,
              {
                name: snap.name || '',
                symbol: snap.token?.symbol || '',
                decimals: snap.token?.decimals ?? 0,
              },
            ]);
          }
        } catch {
          // ignore category
        }
      }

      if (!cancelled && acc.length > 0) {
        setTokenMeta((prev) => ({ ...prev, ...Object.fromEntries(acc) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [categories]);

  function displayNameFor(cat: string) {
    const m = tokenMeta[cat];
    if (!m) return `${cat.slice(0, 8)}…`;
    if (m.name && m.symbol) return `${m.name} (${m.symbol})`;
    if (m.name) return m.name;
    if (m.symbol) return m.symbol;
    return `${cat.slice(0, 8)}…`;
  }

  function formatFtAmount(amount: bigint, decimals: number) {
    const s = amount.toString();
    if (decimals <= 0) return s;
    if (s.length <= decimals) {
      const frac = s.padStart(decimals, '0').replace(/0+$/, '');
      return `0.${frac || '0'}`;
    }
    const whole = s.slice(0, s.length - decimals);
    const frac = s.slice(s.length - decimals).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  }

  // UI helpers / masks
  const prefixLen = PREFIX[currentNetwork]?.length ?? 0;
  const mask = (addr: string) => shortenTxHash(addr, prefixLen);

  // ===== Debug helpers =====
  const inputSum = useMemo(() => {
    if (!Array.isArray(selectedForTx)) return 0n;
    return selectedForTx.reduce(
      (s: bigint, u: any) => s + BigInt(u?.amount ?? u?.value ?? 0),
      0n
    );
  }, [selectedForTx]);

  const outputsTableRows = useMemo(() => {
    if (!review?.finalOutputs?.length) return [];
    return review.finalOutputs.map((o: any, idx: number) => {
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
  }, [review, currentNetwork]);

  const inputsTableRows = useMemo(() => {
    if (!Array.isArray(selectedForTx)) return [];
    return selectedForTx.map((u: any, idx: number) => ({
      i: idx,
      outpoint: `${u?.tx_hash}:${u?.tx_pos}`,
      address: mask(u?.address || ''),
      amount: Number(u?.amount ?? u?.value ?? 0),
      height: u?.height ?? 0,
      token: u?.token ? 'yes' : 'no',
      contract: u?.abi || u?.contractName ? 'yes' : 'no',
    }));
  }, [selectedForTx, currentNetwork]);

  const rawHexLen = review?.rawTx ? review.rawTx.length : 0;

  // UI helpers for token category dropdowns
  const ftCategories = categories.filter((c: any) => c.ftAmount > 0n);
  const nftCategories = categories.filter((c: any) => c.isNft);

  // Simple derived UX state
  const canReview =
    (assetType === 'bch' && !!recipient && !!amountBch) ||
    (assetType === 'ft' &&
      !!recipient &&
      !!selectedCategory &&
      !!amountToken) ||
    (assetType === 'nft' && !!recipient && !!selectedCategory);

  // ─────────────────────────────────────────────────────────────
  // QR Scanner for recipient
  // ─────────────────────────────────────────────────────────────
  const [scanBusy, setScanBusy] = useState(false);

  const handleScanRecipient = async () => {
    try {
      setScanBusy(true);
      const result = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1, // back camera
      });

      const scanned = result?.ScanResult?.trim();
      if (!scanned) {
        await Toast.show({ text: 'No QR detected. Try again.' });
        return;
      }

      const maybeAddr = scanned.startsWith('bitcoincash:') ? scanned : scanned;
      setRecipient(maybeAddr);
      await Toast.show({ text: 'Recipient loaded from QR.' });
    } catch (e) {
      console.error('QR scan failed:', e);
      await Toast.show({
        text: 'Failed to scan QR. Check camera permissions and try again.',
      });
    } finally {
      setScanBusy(false);
    }
  };

  return (
    <div className="container mx-auto p-4 max-w-xl">
      {/* Header */}
      <div className="flex justify-center mt-4">
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="Welcome"
          className="w-3/4 h-auto"
        />
      </div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-extrabold text-emerald-900">
          Simple Send
        </h1>
        <div className="flex items-center gap-3">
          {/* Debug toggle */}
          <label className="flex items-center gap-2 text-xs font-semibold text-emerald-800/90 select-none">
            <input
              type="checkbox"
              className="accent-emerald-600 w-4 h-4"
              checked={showDebug}
              onChange={(e) => setShowDebug(e.target.checked)}
            />
            Debug
          </label>

          <Link
            to="/transaction"
            className="text-sm font-semibold text-emerald-700 hover:text-emerald-600 underline underline-offset-4"
            title="Open Advanced Builder"
          >
            Advanced mode
          </Link>
        </div>
      </div>

      {/* Network */}
      <div className="mb-3 text-xs font-medium text-emerald-800/80">
        Network: <span className="font-mono">{currentNetwork}</span>
      </div>

      {/* Card */}
      <div className="space-y-4 rounded-2xl border border-emerald-300/60 bg-gradient-to-b from-emerald-50 to-white p-4 shadow-md">
        {/* Asset Type */}
        <div className="flex flex-col gap-1">
          <Label>Asset</Label>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              className={`rounded-xl px-3 py-2 font-semibold border ${
                assetType === 'bch'
                  ? 'bg-emerald-500 text-emerald-950 border-emerald-500'
                  : 'bg-white text-emerald-800 border-emerald-200'
              }`}
              onClick={() => setAssetType('bch')}
            >
              BCH
            </button>
            <button
              type="button"
              className={`rounded-xl px-3 py-2 font-semibold border ${
                assetType === 'ft'
                  ? 'bg-emerald-500 text-emerald-950 border-emerald-500'
                  : 'bg-white text-emerald-800 border-emerald-200'
              }`}
              onClick={() => setAssetType('ft')}
            >
              Token (FT)
            </button>
            <button
              type="button"
              className={`rounded-xl px-3 py-2 font-semibold border ${
                assetType === 'nft'
                  ? 'bg-emerald-500 text-emerald-950 border-emerald-500'
                  : 'bg-white text-emerald-800 border-emerald-200'
              }`}
              onClick={() => setAssetType('nft')}
            >
              NFT
            </button>
          </div>
          <div className="text-[11px] text-emerald-900/70">
            Note: Token outputs carry 1,000 sats each to remain spendable.
          </div>
        </div>

        {/* To */}
        <div className="flex flex-col gap-1">
          <Label>To</Label>
          <div className="flex items-center gap-2">
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value.trim())}
              placeholder={
                assetType === 'bch'
                  ? 'bitcoincash:...'
                  : 'bitcoincash: or token-aware address'
              }
              className="w-full rounded-xl bg-white px-3 py-2.5 text-emerald-950 placeholder-emerald-900/40
                       outline-none ring-2 ring-emerald-200 focus:ring-4 focus:ring-emerald-300"
            />
            <button
              type="button"
              onClick={handleScanRecipient}
              disabled={scanBusy}
              title="Scan QR"
              className="shrink-0 inline-flex items-center justify-center rounded-xl px-3 py-2.5 font-semibold
                         bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-500 text-emerald-950 shadow-sm
                         disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <FaCamera />
            </button>
          </div>
          {!!recipient && (
            <div className="text-[11px] text-emerald-900/70">
              {mask(recipient)}
              <button
                className="ml-2 text-emerald-700 underline"
                onClick={() => copy(recipient)}
              >
                Copy
              </button>
            </div>
          )}
        </div>

        {/* Amount (BCH) */}
        {assetType === 'bch' && (
          <div className="flex flex-col gap-1">
            <Label>Amount (BCH)</Label>
            <input
              value={amountBch}
              onChange={(e) => setAmountBch(e.target.value)}
              inputMode="decimal"
              placeholder="0.00000000"
              className="w-full rounded-xl bg-white px-3 py-2.5 text-emerald-950 placeholder-emerald-900/40
                       outline-none ring-2 ring-emerald-200 focus:ring-4 focus:ring-emerald-300"
            />
            <div className="text-[11px] text-emerald-900/70">
              Network fee is calculated at 1 sat/byte. We also keep a small
              buffer to ensure change is spendable.
            </div>
          </div>
        )}

        {/* FT controls */}
        {assetType === 'ft' && (
          <>
            <div className="flex flex-col gap-1">
              <Label>Token category</Label>
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full appearance-none rounded-xl bg-white px-3 py-2.5 text-emerald-950
                           outline-none ring-2 ring-emerald-200 focus:ring-4 focus:ring-emerald-300
                           cursor-pointer"
              >
                <option value="" disabled>
                  Select category…
                </option>
                {ftCategories.map((c: any) => {
                  const pretty = displayNameFor(c.category);
                  const dec = tokenMeta[c.category]?.decimals ?? 0;
                  const human = formatFtAmount(c.ftAmount, dec);
                  return (
                    <option key={c.category} value={c.category}>
                      {pretty} · Balance: {human}
                    </option>
                  );
                })}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Token amount</Label>
              <input
                value={amountToken}
                onChange={(e) =>
                  setAmountToken(e.target.value.replace(/\D/g, ''))
                }
                inputMode="numeric"
                placeholder="e.g., 1000"
                className="w-full rounded-xl bg-white px-3 py-2.5 text-emerald-950 placeholder-emerald-900/40
                         outline-none ring-2 ring-emerald-200 focus:ring-4 focus:ring-emerald-300"
              />
              <div className="text-[11px] text-emerald-900/70">
                BCH inputs are added only to pay network fees. Token change (if
                any) returns to your token-aware change address.
              </div>
            </div>
          </>
        )}

        {/* NFT controls */}
        {assetType === 'nft' && (
          <>
            <div className="flex flex-col gap-1">
              <Label>NFT category</Label>
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full appearance-none rounded-xl bg-white px-3 py-2.5 text-emerald-950
                           outline-none ring-2 ring-emerald-200 focus:ring-4 focus:ring-emerald-300
                           cursor-pointer"
              >
                <option value="" disabled>
                  Select category…
                </option>
                {nftCategories.map((c: any) => {
                  const pretty = displayNameFor(c.category);
                  return (
                    <option key={c.category} value={c.category}>
                      {pretty} · NFTs: {c.nftCommitments.length}
                    </option>
                  );
                })}
              </select>
            </div>
            {/* Optional: choose specific NFT by commitment */}
            {selectedCategory && (
              <div className="flex flex-col gap-1">
                <Label>NFT commitment (optional)</Label>
                <input
                  value={selectedNftCommitment}
                  onChange={(e) =>
                    setSelectedNftCommitment(e.target.value.trim())
                  }
                  placeholder="hex commitment…"
                  className="w-full rounded-xl bg-white px-3 py-2.5 text-emerald-950 placeholder-emerald-900/40
                             outline-none ring-2 ring-emerald-200 focus:ring-4 focus:ring-emerald-300"
                />
                <div className="text-[11px] text-emerald-900/70">
                  Leave blank to send the first available NFT in this category.
                </div>
              </div>
            )}
          </>
        )}

        {/* Change address selector */}
        <div className="flex flex-col gap-1">
          <Label>Change address</Label>
          <div className="relative">
            <select
              value={selectedChangeAddress}
              onChange={(e) => setSelectedChangeAddress(e.target.value)}
              className="w-full appearance-none rounded-xl bg-white px-3 py-2.5 text-emerald-950
                         outline-none ring-2 ring-emerald-200 focus:ring-4 focus:ring-emerald-300
                         cursor-pointer"
            >
              {!addresses.length && (
                <option value="" disabled>
                  Loading…
                </option>
              )}
              {addresses.map((a: any) => (
                <option key={a.address} value={a.address}>
                  {mask(a.address)}
                </option>
              ))}
            </select>
            {/* dropdown chevron */}
            <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-emerald-800/70">
              ▼
            </div>
          </div>

          {/* tiny label for token-aware change destination */}
          <div className="text-[11px] text-emerald-900/70 mt-1">
            Token change will go to:{' '}
            <span className="font-mono">
              {mask(tokenChangeAddress || selectedChangeAddress)}
            </span>
            <button
              className="ml-2 text-emerald-700 underline"
              onClick={() => copy(tokenChangeAddress || selectedChangeAddress)}
            >
              Copy
            </button>
          </div>

          <div className="text-xs text-emerald-900/70">
            Using BCH change:{' '}
            <span className="font-mono">{mask(selectedChangeAddress)}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={doReview}
            disabled={isSending || !canReview}
            className="w-full inline-flex items-center justify-center rounded-xl px-4 py-2.5 font-semibold bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-500 text-emerald-950 shadow-sm shadow-emerald-700/30 focus:outline-none focus:ring-4 focus:ring-emerald-300/60 disabled:opacity-60 disabled:cursor-not-allowed"
            title={!canReview ? 'Fill the required fields first' : 'Review'}
          >
            Review
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={isSending}
            className="w-28 inline-flex items-center justify-center rounded-xl px-4 py-2.5 font-semibold bg-white/70 hover:bg-white text-emerald-900 shadow-sm focus:outline-none focus:ring-4 focus:ring-emerald-200 disabled:opacity-60 disabled:cursor-not-allowed"
            title="Clear form"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Error */}
      {mode === 'error' && error && (
        <div className="mt-4 p-3 rounded-2xl border border-red-300 bg-red-50 text-red-800 text-sm shadow-sm">
          {error}
        </div>
      )}

      {/* Review Card */}
      {mode === 'review' && review && (
        <div className="mt-4 p-4 rounded-2xl border border-emerald-300/60 bg-white shadow-md space-y-2">
          <div className="text-lg font-bold text-emerald-900">Review</div>

          <div className="text-sm space-y-1 text-emerald-950">
            <div className="flex justify-between">
              <span className="font-medium">To</span>
              <span
                className="font-mono truncate max-w-[60%]"
                title={recipient}
              >
                {shortenTxHash(recipient, prefixLen)}
              </span>
            </div>

            {/* Amount / Asset */}
            {assetType === 'bch' && (
              <div className="flex justify-between">
                <span className="font-medium">Amount</span>
                <span>
                  {(Number.parseFloat(amountBch) || 0).toFixed(8)} BCH
                  {!!fiatSummary.amountUsd && (
                    <span className="opacity-70">
                      {' '}
                      · ${fiatSummary.amountUsd.toFixed(2)} USD
                    </span>
                  )}
                </span>
              </div>
            )}

            {assetType !== 'bch' && (
              <div className="flex justify-between">
                <span className="font-medium">Asset</span>
                <span className="font-mono">
                  {assetType.toUpperCase()} ·{' '}
                  {selectedCategory ? displayNameFor(selectedCategory) : '—'}
                  {assetType === 'ft' && amountToken
                    ? ` · amount: ${amountToken}`
                    : ''}
                </span>
              </div>
            )}

            {/* Token change pretty-print */}
            {review.tokenChange && (
              <div className="flex justify-between">
                <span className="font-medium">Token change</span>
                <span
                  className="font-mono"
                  title={review.tokenChange.amount.toString()}
                >
                  {(() => {
                    const dec =
                      tokenMeta[review.tokenChange!.category]?.decimals ?? 0;
                    const pretty = formatFtAmount(
                      review.tokenChange!.amount,
                      dec
                    );
                    const name = displayNameFor(review.tokenChange!.category);
                    return `${pretty} ${name}`;
                  })()}
                </span>
              </div>
            )}

            <div className="flex justify-between">
              <span className="font-medium">Fee</span>
              <span>
                {(review.feeSats / 100_000_000).toFixed(8)} BCH
                {!!fiatSummary.feeUsd && (
                  <span className="opacity-70">
                    {' '}
                    · ${fiatSummary.feeUsd.toFixed(2)} USD
                  </span>
                )}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="font-medium">Total (BCH)</span>
              <span>
                {(review.totalSats / 100_000_000).toFixed(8)} BCH
                {!!fiatSummary.totalUsd && (
                  <span className="opacity-70">
                    {' '}
                    · ${fiatSummary.totalUsd.toFixed(2)} USD
                  </span>
                )}
              </span>
            </div>
            <div className="flex justify-between text-xs text-emerald-900/70">
              <span>Outputs</span>
              <span>{review.finalOutputs.length}</span>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={openConfirm}
              disabled={isSending}
              className="w-full inline-flex items-center justify-center rounded-xl px-4 py-2.5 font-semibold bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-500 text-emerald-950 shadow-sm focus:outline-none focus:ring-4 focus:ring-emerald-300/60 disabled:opacity-60 disabled:cursor-not-allowed"
              title="Swipe to confirm"
            >
              Send
            </button>
            <button
              type="button"
              onClick={() => window.history.back()}
              className="w-28 inline-flex items-center justify-center rounded-xl px-4 py-2.5 font-semibold bg-white/70 hover:bg-white text-emerald-900 shadow-sm focus:outline-none focus:ring-4 focus:ring-emerald-200"
              title="Edit details"
            >
              Edit
            </button>
          </div>
        </div>
      )}

      {/* ===== DEBUG PANEL ===== */}
      {showDebug && (
        <div className="mt-4 p-4 rounded-2xl border border-amber-300/60 bg-amber-50 shadow-md space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-base font-extrabold text-amber-900">
              Debug: Inputs & Outputs
            </div>
            <div className="flex items-center gap-2">
              {review?.rawTx && (
                <button
                  type="button"
                  onClick={() => copy(review.rawTx)}
                  className="text-xs px-2 py-1 rounded-md bg-white hover:bg-amber-100 text-amber-900 border border-amber-300"
                  title="Copy raw hex"
                >
                  Copy raw hex
                </button>
              )}
              {review?.finalOutputs && (
                <button
                  type="button"
                  onClick={() =>
                    copy(
                      JSON.stringify(
                        review.finalOutputs,
                        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
                        2
                      )
                    )
                  }
                  className="text-xs px-2 py-1 rounded-md bg-white hover:bg-amber-100 text-amber-900 border border-amber-300"
                  title="Copy outputs JSON"
                >
                  Copy outputs JSON
                </button>
              )}
              {Array.isArray(selectedForTx) && selectedForTx.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    copy(
                      JSON.stringify(
                        selectedForTx,
                        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
                        2
                      )
                    )
                  }
                  className="text-xs px-2 py-1 rounded-md bg-white hover:bg-amber-100 text-amber-900 border border-amber-300"
                  title="Copy inputs JSON"
                >
                  Copy inputs JSON
                </button>
              )}
            </div>
          </div>

          {/* Summary */}
          <div className="grid grid-cols-2 gap-3 text-xs text-amber-900">
            <div className="rounded-lg bg-white/80 p-3 border border-amber-200">
              <div className="font-semibold mb-1">Inputs summary</div>
              <div>
                Total inputs:{' '}
                {Array.isArray(selectedForTx) ? selectedForTx.length : 0}
              </div>
              <div>
                Sum (sats):{' '}
                <span className="font-mono">{inputSum.toString()}</span>
              </div>
            </div>
            <div className="rounded-lg bg-white/80 p-3 border border-amber-200">
              <div className="font-semibold mb-1">Build summary</div>
              <div>Outputs: {review?.finalOutputs?.length ?? 0}</div>
              <div>Raw hex bytes: {Math.ceil(rawHexLen / 2)}</div>
            </div>
          </div>

          {/* Inputs table */}
          <div className="rounded-lg bg-white border border-amber-200">
            <div className="flex items-center justify-between px-3 py-2 border-b border-amber-200">
              <div className="text-sm font-bold text-amber-900">
                Selected inputs
              </div>
              <button
                type="button"
                className="text-xs text-amber-700 underline"
                onClick={() => setShowInputsJson((v) => !v)}
              >
                {showInputsJson ? 'Hide JSON' : 'Show JSON'}
              </button>
            </div>

            {!showInputsJson ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-amber-100/70 text-amber-900">
                    <tr>
                      <th className="text-left px-3 py-2">#</th>
                      <th className="text-left px-3 py-2">Outpoint</th>
                      <th className="text-left px-3 py-2">Address</th>
                      <th className="text-right px-3 py-2">Sats</th>
                      <th className="text-right px-3 py-2">Height</th>
                      <th className="text-center px-3 py-2">Token</th>
                      <th className="text-center px-3 py-2">Contract</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedForTx.length === 0 ? (
                      <tr>
                        <td
                          className="px-3 py-3 text-center text-amber-700"
                          colSpan={7}
                        >
                          No inputs selected yet (run Review).
                        </td>
                      </tr>
                    ) : (
                      inputsTableRows.map((r) => (
                        <tr
                          key={r.outpoint}
                          className="border-t border-amber-100"
                        >
                          <td className="px-3 py-2">{r.i}</td>
                          <td className="px-3 py-2 font-mono">{r.outpoint}</td>
                          <td className="px-3 py-2 font-mono">{r.address}</td>
                          <td className="px-3 py-2 text-right">{r.amount}</td>
                          <td className="px-3 py-2 text-right">{r.height}</td>
                          <td className="px-3 py-2 text-center">{r.token}</td>
                          <td className="px-3 py-2 text-center">
                            {r.contract}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <pre className="text-xs p-3 overflow-auto max-h-64 text-amber-900">
                {JSON.stringify(
                  selectedForTx,
                  (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
                  2
                )}
              </pre>
            )}
          </div>

          {/* Outputs table */}
          <div className="rounded-lg bg-white border border-amber-200">
            <div className="flex items-center justify-between px-3 py-2 border-b border-amber-200">
              <div className="text-sm font-bold text-amber-900">
                Final outputs
              </div>
              <button
                type="button"
                className="text-xs text-amber-700 underline"
                onClick={() => setShowOutputsJson((v) => !v)}
              >
                {showOutputsJson ? 'Hide JSON' : 'Show JSON'}
              </button>
            </div>

            {!showOutputsJson ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-amber-100/70 text-amber-900">
                    <tr>
                      <th className="text-left px-3 py-2">#</th>
                      <th className="text-left px-3 py-2">Type</th>
                      <th className="text-left px-3 py-2">Recipient</th>
                      <th className="text-right px-3 py-2">Sats</th>
                      <th className="text-left px-3 py-2">Token</th>
                      <th className="text-left px-3 py-2">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outputsTableRows.length === 0 ? (
                      <tr>
                        <td
                          className="px-3 py-3 text-center text-amber-700"
                          colSpan={6}
                        >
                          No outputs yet (run Review).
                        </td>
                      </tr>
                    ) : (
                      outputsTableRows.map((r) => (
                        <tr key={r.i} className="border-t border-amber-100">
                          <td className="px-3 py-2">{r.i}</td>
                          <td className="px-3 py-2">{r.type}</td>
                          <td className="px-3 py-2 font-mono">{r.address}</td>
                          <td className="px-3 py-2 text-right">{r.amount}</td>
                          <td className="px-3 py-2">{r.token}</td>
                          <td className="px-3 py-2">{r.details}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <pre className="text-xs p-3 overflow-auto max-h-64 text-amber-900">
                {JSON.stringify(
                  review?.finalOutputs ?? [],
                  (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
                  2
                )}
              </pre>
            )}
          </div>

          {/* Raw TX preview */}
          <div className="rounded-lg bg-white border border-amber-200">
            <div className="flex items-center justify-between px-3 py-2 border-amber-200 border-b">
              <div className="text-sm font-bold text-amber-900">
                Raw transaction
              </div>
              <div className="text-xs text-amber-700">
                bytes:{' '}
                <span className="font-mono">{Math.ceil(rawHexLen / 2)}</span>
              </div>
            </div>
            <pre className="text-xs p-3 overflow-auto max-h-64 text-amber-900 break-all">
              {review?.rawTx ?? '(no tx built yet)'}
            </pre>
          </div>
        </div>
      )}

      {/* Sent */}
      {mode === 'sent' && txid && (
        <div className="mt-4 p-4 rounded-2xl border border-emerald-400 bg-emerald-50 text-sm shadow-sm">
          <div className="font-semibold mb-1 text-emerald-900">
            Transaction sent ✅
          </div>
          <div className="break-all font-mono text-emerald-900">{txid}</div>
        </div>
      )}

      {/* Swipe-to-confirm Modal */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl p-5">
            <div className="text-xl font-extrabold text-emerald-900 mb-1">
              Confirm Transaction
            </div>
            <div className="text-sm text-emerald-900/80 mb-4">
              Review looks good? Swipe to send. This action cannot be undone.
            </div>

            <div className="relative h-14 w-full bg-emerald-100 rounded-xl overflow-hidden select-none">
              {/* Fill/feedback */}
              <div
                className={`absolute top-0 left-0 h-full transition-all duration-200 ${
                  sliderPos.x >= threshold
                    ? 'bg-emerald-500'
                    : sliderPos.x > 0
                      ? 'bg-amber-400'
                      : 'bg-emerald-200'
                }`}
                style={{ width: Math.max(0, sliderPos.x) }}
              />
              {/* Center text */}
              <div className="absolute inset-0 flex items-center justify-center text-[13px] font-bold text-emerald-950/80 pointer-events-none">
                Drag to Confirm
              </div>
              {/* Draggable handle */}
              <Draggable
                axis="x"
                position={sliderPos}
                onDrag={(e, data) => {
                  void e;
                  if (!isSending) setSliderPos({ x: data.x, y: 0 });
                }}
                onStop={onSwipeStop}
                bounds={{ left: 0, right: sliderWidth - handleWidth }}
                disabled={isSending}
              >
                <div
                  className={`absolute top-1/2 -translate-y-1/2 w-12 h-12 rounded-xl bg-emerald-600 text-white
                              flex items-center justify-center text-lg shadow-md ${
                                isSending
                                  ? 'opacity-60 cursor-not-allowed'
                                  : 'cursor-grab'
                              }`}
                  style={{ left: 0 }}
                  title="Drag to confirm"
                >
                  {sliderPos.x >= threshold ? '✅' : '➔'}
                </div>
              </Draggable>
            </div>

            <div className="mt-4 flex justify-between">
              <button
                type="button"
                onClick={closeConfirm}
                className="inline-flex items-center justify-center rounded-xl px-4 py-2.5 font-semibold bg-white text-emerald-900 border border-emerald-300 hover:bg-emerald-50"
              >
                Back
              </button>
              <div className="text-xs text-emerald-900/70 self-center">
                Slide handle to the right to send
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
