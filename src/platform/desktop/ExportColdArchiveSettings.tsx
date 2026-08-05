// Settings → Wallet & security → Wallet export pack
// Same as menu Wallet → Export Wallet / File → Open Wallet Pack.

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
    const password = window.prompt(
      'Wallet password — exports two files:\n' +
        '1) .optn  keystore (encrypted seed)\n' +
        '2) .optn-cold  wallet data (encrypted history, labels, fusion, coins…)'
    );
    if (password === null) return;
    if (!password) {
      setMsg('Password required.');
      return;
    }
    setBusy(true);
    setMsg('Exporting…');
    try {
      const { exportWalletPack } = await import('./WalletPackService');
      const result = await exportWalletPack(walletId, password, null);
      setMsg(
        `Saved pack:\n` +
          `Keys: ${result.keystorePath}\n` +
          (result.coldPath
            ? `Data: ${result.coldPath}`
            : `Data skipped: ${result.coldSkippedReason ?? 'unknown'}`)
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Export failed.';
      if (text.includes('cancelled')) setMsg('Export cancelled.');
      else {
        logError('ExportColdArchiveSettings.export', err, { walletId });
        setMsg(text);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleImportDataOnly = async () => {
    if (!walletId || busy) return;
    setBusy(true);
    setMsg('Choose .optn-cold (or both files)…');
    try {
      const { pickWalletPackFiles, importColdDataIntoOpenWallet } = await import(
        './WalletPackService'
      );
      const pack = await pickWalletPackFiles(null);
      if (!pack) {
        setMsg('Import cancelled.');
        return;
      }
      if (!pack.coldText) {
        setMsg(
          'No .optn-cold data file selected. Hold Ctrl and select both .optn and .optn-cold, or only the data file for this open wallet.'
        );
        return;
      }
      const password = window.prompt(
        'Password for the encrypted wallet data file:'
      );
      if (password === null) {
        setMsg('Import cancelled.');
        return;
      }
      if (!password) {
        setMsg('Password required.');
        return;
      }
      const stats = await importColdDataIntoOpenWallet(
        walletId,
        pack.coldText,
        password
      );
      setMsg(
        `Imported data into this wallet:\n` +
          `· ${stats.labels} labels\n` +
          `· ${stats.fusionCoins} fusion depths\n` +
          `· ${stats.fusionTxids} fusion txids\n` +
          (pack.keystore
            ? '(Keystore in selection is ignored here — use File → Open Wallet Pack to import keys.)\n'
            : '') +
          `Live balance still comes from the network.`
      );
    } catch (err) {
      logError('ExportColdArchiveSettings.import', err, { walletId });
      setMsg(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-2">
        <p className="text-sm font-semibold wallet-text-strong">
          Wallet pack (two files)
        </p>
        <p className="text-xs wallet-muted">
          <span className="wallet-text-strong">Export Wallet</span> always writes
          two files next to each other:
        </p>
        <ul className="text-xs wallet-muted list-disc pl-4 space-y-1">
          <li>
            <code className="wallet-text-strong">.optn</code> — keystore
            (encrypted seed; needs password to open)
          </li>
          <li>
            <code className="wallet-text-strong">.optn-cold</code> — wallet data
            (encrypted with the same password: addresses, UTXOs/NFT-FT tokens,
            history, labels, fusion depth; room for contacts later)
          </li>
        </ul>
        <p className="text-xs wallet-muted">
          <span className="wallet-text-strong">Import:</span> File →{' '}
          <span className="wallet-text-strong">Open Wallet Pack…</span> — hold{' '}
          <span className="wallet-text-strong">Ctrl</span> and select both files,
          or pick only <code>.optn-cold</code> while this wallet is open to
          restore data only.
        </p>
        {msg && (
          <p
            className={`text-xs whitespace-pre-wrap break-all ${
              busy
                ? 'wallet-muted'
                : msg.startsWith('Saved pack') || msg.startsWith('Imported')
                  ? 'text-green-400'
                  : msg.includes('cancelled')
                    ? 'wallet-muted'
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
          {busy ? 'Working…' : 'Export wallet pack (2 files)…'}
        </button>
        <button
          type="button"
          disabled={busy || !walletId}
          onClick={() => void handleImportDataOnly()}
          className="w-full rounded-xl border border-[var(--wallet-border)] py-2.5 text-sm font-semibold wallet-text-strong hover:opacity-80 disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Import data file into this wallet…'}
        </button>
      </div>
    </div>
  );
};
