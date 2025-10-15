// src/pages/SimpleSend.tsx

import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import useSimpleSend from '../hooks/useSimpleSend';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-sm font-semibold text-emerald-900/90">
      {children}
    </label>
  );
}

function truncateAddr(addr: string, left = 10, right = 8) {
  if (!addr) return '—';
  if (addr.length <= left + right) return addr;
  return `${addr.slice(0, left)}…${addr.slice(-right)}`;
}

function copy(text: string) {
  try {
    navigator.clipboard.writeText(text);
  } catch {}
}

export default function SimpleSend() {
  const {
    // form
    assetType,
    setAssetType,
    recipient,
    setRecipient,
    amountBch,
    setAmountBch,

    // token ui
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
    selectedForTx, // UTXO[] chosen during doReview()
  } = useSimpleSend() as any;

  const isSending = mode === 'sending';
  const [showDebug, setShowDebug] = useState(false);
  const [showInputsJson, setShowInputsJson] = useState(false);
  const [showOutputsJson, setShowOutputsJson] = useState(false);

  const primaryBtn =
    'w-full inline-flex items-center justify-center rounded-xl px-4 py-2.5 font-semibold ' +
    'bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-500 ' +
    'text-emerald-950 shadow-sm shadow-emerald-700/30 ' +
    'focus:outline-none focus:ring-4 focus:ring-emerald-300/60 ' +
    'disabled:opacity-60 disabled:cursor-not-allowed';
  const secondaryBtn =
    'w-28 inline-flex items-center justify-center rounded-xl px-4 py-2.5 font-semibold ' +
    'bg-white/70 hover:bg-white text-emerald-900 ' +
    'shadow-sm focus:outline-none focus:ring-4 focus:ring-emerald-200 ' +
    'disabled:opacity-60 disabled:cursor-not-allowed';

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
      const token = (o as any).token ? JSON.stringify((o as any).token) : '—';
      return {
        i: idx,
        type: 'P2PKH',
        address: (o as any).recipientAddress,
        amount: Number((o as any).amount || 0),
        token,
        details: '',
      };
    });
  }, [review]);

  const inputsTableRows = useMemo(() => {
    if (!Array.isArray(selectedForTx)) return [];
    return selectedForTx.map((u: any, idx: number) => ({
      i: idx,
      outpoint: `${u?.tx_hash}:${u?.tx_pos}`,
      address: u?.address,
      amount: Number(u?.amount ?? u?.value ?? 0),
      height: u?.height ?? 0,
      token: u?.token ? 'yes' : 'no',
      contract: u?.abi || u?.contractName ? 'yes' : 'no',
    }));
  }, [selectedForTx]);

  const rawHexLen = review?.rawTx ? review.rawTx.length : 0;

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
        {/* Asset type */}
        <div className="flex flex-col gap-1">
          <Label>Asset</Label>
          <div className="grid grid-cols-3 gap-2">
            {(['bch', 'ft', 'nft'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setAssetType(t)}
                className={
                  'rounded-xl px-3 py-2.5 font-semibold border ' +
                  (assetType === t
                    ? 'bg-emerald-500 text-emerald-950 border-emerald-600'
                    : 'bg-white text-emerald-900 border-emerald-200 hover:border-emerald-300')
                }
              >
                {t === 'bch' ? 'BCH' : t === 'ft' ? 'Fungible Token' : 'NFT'}
              </button>
            ))}
          </div>
        </div>

        {/* To */}
        <div className="flex flex-col gap-1">
          <Label>To</Label>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={
              assetType === 'bch'
                ? 'bitcoincash:...'
                : 'token-aware address (bitcoincash:/simpleledger:)'
            }
            className="w-full rounded-xl bg-white px-3 py-2.5 text-emerald-950 placeholder-emerald-900/40
                       outline-none ring-2 ring-emerald-200 focus:ring-4 focus:ring-emerald-300"
          />
          {/* TODO: add QR scanner button next to input */}
        </div>

        {/* Amount / Token controls */}
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
          </div>
        )}

        {(assetType === 'ft' || assetType === 'nft') && (
          <>
            {/* Category */}
            <div className="flex flex-col gap-1">
              <Label>Token category</Label>
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full rounded-xl bg-white px-3 py-2.5 text-emerald-950 outline-none ring-2 ring-emerald-200 focus:ring-4 focus:ring-emerald-300"
              >
                {!tokenCategories.length && (
                  <option value="" disabled>
                    Loading…
                  </option>
                )}
                {tokenCategories.map((cat: string) => (
                  <option key={cat} value={cat}>
                    {cat.slice(0, 18)}…{cat.slice(-6)}
                  </option>
                ))}
              </select>
              <div className="text-xs text-emerald-900/70">
                Only this category will be included.
              </div>
            </div>

            {/* FT amount */}
            {assetType === 'ft' && (
              <div className="flex flex-col gap-1">
                <Label>Token amount (integer)</Label>
                <input
                  value={tokenAmount}
                  onChange={(e) => setTokenAmount(e.target.value)}
                  inputMode="numeric"
                  placeholder="e.g. 1000"
                  className="w-full rounded-xl bg-white px-3 py-2.5 text-emerald-950 placeholder-emerald-900/40
                             outline-none ring-2 ring-emerald-200 focus:ring-4 focus:ring-emerald-300"
                />
                <div className="text-xs text-emerald-900/70">
                  BCH inputs are added automatically for fees.
                </div>
              </div>
            )}

            {/* NFT selector */}
            {assetType === 'nft' && (
              <div className="flex flex-col gap-1">
                <Label>NFT</Label>
                <select
                  value={selectedNft?.commitment || ''}
                  onChange={(e) => {
                    const c = e.target.value;
                    const nft =
                      availableNfts.find((n: any) => n.commitment === c) ||
                      null;
                    setSelectedNft(nft);
                  }}
                  className="w-full rounded-xl bg-white px-3 py-2.5 text-emerald-950 outline-none ring-2 ring-emerald-200 focus:ring-4 focus:ring-emerald-300"
                >
                  {!availableNfts.length && (
                    <option value="" disabled>
                      No NFTs in this category
                    </option>
                  )}
                  {availableNfts.map((n: any) => (
                    <option key={n.commitment} value={n.commitment}>
                      {n.capability}@{n.commitment.slice(0, 12)}…
                      {n.commitment.slice(-6)}
                    </option>
                  ))}
                </select>
                <div className="text-xs text-emerald-900/70">
                  Only the selected NFT will be sent.
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
                  {truncateAddr(a.address)}
                </option>
              ))}
            </select>
            {/* dropdown chevron */}
            <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-emerald-800/70">
              ▼
            </div>
          </div>
          <div className="text-xs text-emerald-900/70">
            Using change:{' '}
            <span className="font-mono">
              {truncateAddr(selectedChangeAddress)}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={doReview}
            disabled={isSending}
            className={primaryBtn}
          >
            Review
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={isSending}
            className={secondaryBtn}
            title="Clear form"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Error */}
      {mode === 'error' && error && (
        <div className="mt-4 p-3 rounded-xl border border-red-300 bg-red-50 text-red-800 text-sm shadow-sm">
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
                {recipient}
              </span>
            </div>

            {/* Amount line is meaningful for BCH; for tokens, USD rows show fee totals */}
            <div className="flex justify-between">
              <span className="font-medium">
                {assetType === 'bch' ? 'Amount' : 'Token fee (BCH)'}
              </span>
              <span>
                {(Number.parseFloat(amountBch) || 0).toFixed(8)} BCH
                {!!fiatSummary.amountUsd && assetType === 'bch' && (
                  <span className="opacity-70">
                    {' '}
                    · ${fiatSummary.amountUsd.toFixed(2)} USD
                  </span>
                )}
              </span>
            </div>

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
              <span className="font-medium">Total</span>
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

            {/* Small token summary when applicable */}
            {(assetType === 'ft' || assetType === 'nft') && (
              <div className="text-xs mt-1 text-emerald-900/80 space-y-0.5">
                <div>
                  <span className="font-medium">Category:</span>{' '}
                  <span className="font-mono">
                    {selectedCategory
                      ? `${selectedCategory.slice(0, 14)}…${selectedCategory.slice(-6)}`
                      : '—'}
                  </span>
                </div>
                {assetType === 'ft' && (
                  <div>
                    <span className="font-medium">FT amount:</span>{' '}
                    {tokenAmount || 0}
                  </div>
                )}
                {assetType === 'nft' && selectedNft && (
                  <div>
                    <span className="font-medium">NFT:</span>{' '}
                    {selectedNft.capability}@
                    {selectedNft.commitment.slice(0, 10)}…
                    {selectedNft.commitment.slice(-6)}
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-between text-xs text-emerald-900/70">
              <span>Outputs</span>
              <span>{review.finalOutputs.length}</span>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={doSend}
              disabled={isSending}
              className={primaryBtn}
            >
              Send
            </button>
            <button
              type="button"
              onClick={() => window.history.back()}
              className={secondaryBtn}
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
                    copy(JSON.stringify(review.finalOutputs, null, 2))
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
                  onClick={() => copy(JSON.stringify(selectedForTx, null, 2))}
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
                    {inputsTableRows.length === 0 ? (
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
                          <td className="px-3 py-2 font-mono">
                            {truncateAddr(r.address)}
                          </td>
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
                {JSON.stringify(selectedForTx ?? [], null, 2)}
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
                          <td className="px-3 py-2 font-mono">
                            {r.address ? truncateAddr(r.address) : '—'}
                          </td>
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
                {JSON.stringify(review?.finalOutputs ?? [], null, 2)}
              </pre>
            )}
          </div>

          {/* Raw TX preview */}
          <div className="rounded-lg bg-white border border-amber-200">
            <div className="flex items-center justify-between px-3 py-2 border-b border-amber-200">
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
    </div>
  );
}
