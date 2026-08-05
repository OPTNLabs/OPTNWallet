// Settings → Wallet pack export (same as Wallet → Export Wallet / Open Wallet Pack)

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
    setMsg('Exporting…');
    try {
      const { exportWalletPack } = await import('./WalletPackService');
      // Password from unlock session / empty-password wallet / prompt only if needed.
      const result = await exportWalletPack(walletId, null);
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

  const handleImport = async () => {
    if (!walletId || busy) return;
    setBusy(true);
    setMsg('Choose .optn and/or .optn-cold…');
    try {
      const {
        pickWalletPackFiles,
        importColdDataIntoOpenWallet,
      } = await import('./WalletPackService');
      const { resolveWalletPassword } = await import(
        './WalletColdExportService'
      );
      const pack = await pickWalletPackFiles(null);
      if (!pack) {
        setMsg('Import cancelled.');
        return;
      }

      if (pack.keystore && !pack.coldText) {
        setMsg(
          'Found .optn but no .optn-cold next to it.\n' +
            'Export Wallet writes both files in the same folder — pick that .optn again,\n' +
            'or choose the .optn-cold file directly.'
        );
        return;
      }

      if (!pack.coldText) {
        setMsg(
          'No .optn-cold data file found.\n' +
            'Select the .optn-cold file (or the .optn sitting next to it).'
        );
        return;
      }

      const password = await resolveWalletPassword(
        walletId,
        'Password for the encrypted data file (.optn-cold):'
      );
      if (password === null) {
        setMsg('Import cancelled.');
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
          (pack.keystorePath
            ? `(Also found keystore — use File → Open Wallet Pack to import keys into a new row.)\n`
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
          Same as <span className="wallet-text-strong">Wallet → Export Wallet</span>:
        </p>
        <ul className="text-xs wallet-muted list-disc pl-4 space-y-1">
          <li>
            <code className="wallet-text-strong">.optn</code> — keystore
            (encrypted seed)
          </li>
          <li>
            <code className="wallet-text-strong">.optn-cold</code> — data
            (encrypted; written next to the keystore automatically)
          </li>
        </ul>
        <p className="text-xs wallet-muted">
          Password is asked only if the wallet is locked and has a non-empty
          password. Unlocked / no-password wallets export without a prompt.
        </p>
        <p className="text-xs wallet-muted">
          <span className="wallet-text-strong">Import:</span> File → Open Wallet
          Pack — pick the <code>.optn</code> (companion <code>.optn-cold</code>{' '}
          loads automatically if it sits next to it). Or import data only with
          the button below.
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
          onClick={() => void handleImport()}
          className="w-full rounded-xl border border-[var(--wallet-border)] py-2.5 text-sm font-semibold wallet-text-strong hover:opacity-80 disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Import data (.optn-cold) into this wallet…'}
        </button>
      </div>
    </div>
  );
};
