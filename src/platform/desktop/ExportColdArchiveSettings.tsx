// Settings → Wallet & security → Export archive
// COLD memory export only — never seed/keys.

import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { selectWalletId } from '../../state/slices/walletSlice';
import { logError } from '../../utils/errorHandling';

export const ExportColdArchiveSettings: React.FC = () => {
  const walletId = useSelector(selectWalletId);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const handleExport = async () => {
    if (!walletId || busy) return;
    setBusy(true);
    setMsg('Building archive…');
    try {
      const { exportAndDownloadColdArchive } = await import(
        './WalletColdExportService'
      );
      const archive = await exportAndDownloadColdArchive(walletId);
      setMsg(
        `Exported: ${archive.utxos.length} coins, ${archive.transactions.length} txs, ` +
          `${archive.labels.length} labels, ${archive.addresses.length} addresses. ` +
          `No seed or private keys included.`
      );
      setTimeout(() => setMsg(''), 8000);
    } catch (err) {
      logError('ExportColdArchiveSettings.export', err, { walletId });
      setMsg(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-2">
        <p className="text-sm font-semibold wallet-text-strong">
          Export cold archive
        </p>
        <p className="text-xs wallet-muted">
          Downloads a JSON file with this wallet&apos;s long-term memory:
          addresses, current coins, transaction history, labels, and fusion
          depth. Use it to keep a 40-year trail of where coins came from.
        </p>
        <p className="text-xs wallet-muted">
          <span className="wallet-text-strong">Does not include</span> your
          recovery phrase, private keys, or passwords. That stays under{' '}
          <span className="wallet-text-strong">Recovery Phrase</span> — export
          the seed separately if you need a full spend-recovery backup.
        </p>
        <ul className="text-xs wallet-muted list-disc pl-4 space-y-1">
          <li>Receive / change addresses (public)</li>
          <li>Current UTXOs (outpoints + amounts)</li>
          <li>Transaction history rows</li>
          <li>Coin / tx labels</li>
          <li>CashFusion depth map + fusion txids</li>
        </ul>
        {msg && (
          <p
            className={`text-xs ${
              busy
                ? 'wallet-muted'
                : msg.startsWith('Exported')
                  ? 'text-green-400'
                  : 'text-red-400'
            }`}
          >
            {msg}
          </p>
        )}
        <button
          type="button"
          disabled={busy || !walletId}
          onClick={() => void handleExport()}
          className="w-full rounded-xl border border-[var(--wallet-border)] py-2.5 text-sm font-semibold wallet-text-strong hover:opacity-80 disabled:opacity-50"
        >
          {busy ? 'Exporting…' : 'Download cold archive (JSON)'}
        </button>
      </div>
    </div>
  );
};
