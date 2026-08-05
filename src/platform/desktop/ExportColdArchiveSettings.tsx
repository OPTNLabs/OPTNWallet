// Settings → Wallet & security → Export / import cold archive
// Encrypted with wallet password. No seed in the file.

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
      'Enter this wallet’s password to encrypt the cold archive.\n' +
        '(Same password you use to unlock the wallet. The file is not usable without it.)'
    );
    if (password === null) return;
    if (!password) {
      setMsg('Password required to encrypt the archive.');
      return;
    }
    setBusy(true);
    setMsg('Encrypting and saving…');
    try {
      const { exportEncryptedColdArchive } = await import(
        './WalletColdExportService'
      );
      const { archive, savedPath } = await exportEncryptedColdArchive(
        walletId,
        password
      );
      if (savedPath) {
        setMsg(
          `Saved encrypted archive to:\n${savedPath}\n\n` +
            `${archive.utxos.length} coins · ${archive.transactions.length} txs · ` +
            `${archive.labels.length} labels · ${archive.addresses.length} addresses.\n` +
            `Encrypted with wallet password. No seed inside.`
        );
      } else {
        setMsg('Save cancelled.');
      }
    } catch (err) {
      logError('ExportColdArchiveSettings.export', err, { walletId });
      setMsg(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async () => {
    if (!walletId || busy) return;
    const password = window.prompt(
      'Enter the password used to encrypt this cold archive\n' +
        '(usually this wallet’s unlock password).'
    );
    if (password === null) return;
    if (!password) {
      setMsg('Password required to decrypt the archive.');
      return;
    }
    setBusy(true);
    setMsg('Opening archive…');
    try {
      const { importEncryptedColdArchiveFromFile } = await import(
        './WalletColdExportService'
      );
      const stats = await importEncryptedColdArchiveFromFile(
        walletId,
        password
      );
      setMsg(
        `Imported into this wallet:\n` +
          `· ${stats.labels} labels\n` +
          `· ${stats.fusionCoins} fusion depth entries\n` +
          `· ${stats.fusionTxids} fusion txids\n` +
          `Balance/coins still come from the network (HOT) — not from the file.`
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Import failed.';
      if (text.includes('cancelled')) {
        setMsg('Import cancelled.');
      } else {
        logError('ExportColdArchiveSettings.import', err, { walletId });
        setMsg(text);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-2">
        <p className="text-sm font-semibold wallet-text-strong">
          Cold archive (encrypted)
        </p>
        <p className="text-xs wallet-muted">
          Backup and restore long-term memory: addresses snapshot, coins
          snapshot, history, labels, and fusion depth. The file is encrypted
          with <span className="wallet-text-strong">this wallet&apos;s password</span>{' '}
          (same PBKDF2 + AES-GCM family as the wallet file).
        </p>
        <p className="text-xs wallet-muted">
          <span className="wallet-text-strong">Not included:</span> recovery
          phrase / private keys. For spending keys use{' '}
          <span className="wallet-text-strong">Export Wallet</span> or{' '}
          <span className="wallet-text-strong">Recovery Phrase</span>.
        </p>
        <p className="text-xs wallet-muted">
          Import restores labels and fusion depth only — it never overwrites
          your live balance from the file.
        </p>
        {msg && (
          <p
            className={`text-xs whitespace-pre-wrap break-all ${
              busy
                ? 'wallet-muted'
                : msg.startsWith('Saved encrypted') || msg.startsWith('Imported')
                  ? 'text-green-400'
                  : msg.startsWith('Save cancelled') ||
                      msg.startsWith('Import cancelled')
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
          {busy ? 'Working…' : 'Export encrypted cold archive…'}
        </button>
        <button
          type="button"
          disabled={busy || !walletId}
          onClick={() => void handleImport()}
          className="w-full rounded-xl border border-[var(--wallet-border)] py-2.5 text-sm font-semibold wallet-text-strong hover:opacity-80 disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Import encrypted cold archive…'}
        </button>
      </div>
    </div>
  );
};
