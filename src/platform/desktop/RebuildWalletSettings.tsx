// Settings → Wallet & security → Rebuild Wallet
// Nuclear chain-data wipe + full network resync. Not Manual Sync (Home).

import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { selectWalletId } from '../../state/slices/walletSlice';

export const RebuildWalletSettings: React.FC = () => {
  const walletId = useSelector(selectWalletId);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [rebuildMsg, setRebuildMsg] = useState('');

  const handleRebuildWallet = async () => {
    if (!walletId || rebuildBusy) return;
    const ok = window.confirm(
      'Rebuild this wallet from the network?\n\n' +
        'This wipes local UTXOs, history, and ledger data, then re-downloads everything. ' +
        'Your seed and keys are kept. Prefer Home → Sync first for ordinary updates.\n\n' +
        'Continue?'
    );
    if (!ok) return;
    setRebuildBusy(true);
    setRebuildMsg('Starting rebuild…');
    try {
      const { rebuildActiveWallet } = await import('./WalletRebuildService');
      const result = await rebuildActiveWallet((msg, pct) => {
        setRebuildMsg(pct != null ? `${msg} (${pct}%)` : msg);
      });
      if ('error' in result) {
        setRebuildMsg(result.error);
      } else {
        setRebuildMsg('Rebuild complete.');
        setTimeout(() => setRebuildMsg(''), 5000);
      }
    } catch (err) {
      console.error('[RebuildWalletSettings] Rebuild failed:', err);
      setRebuildMsg(err instanceof Error ? err.message : 'Rebuild failed.');
    } finally {
      setRebuildBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-red-500/40 bg-[var(--wallet-surface)] p-4 space-y-2">
        <p className="text-sm font-semibold wallet-text-strong">Rebuild Wallet</p>
        <p className="text-xs wallet-muted">
          Last resort if balances or history look corrupted. Wipes local chain data
          (UTXOs, history, ledger) and re-downloads from Electrum. Keeps your seed and
          keys. Requires network.
        </p>
        <p className="text-xs wallet-muted">
          Prefer <span className="wallet-text-strong">Home → Sync</span> for ordinary
          updates. Rebuild is nuclear — not the same as a force recheck.
        </p>
        {rebuildMsg && (
          <p
            className={`text-xs ${
              rebuildBusy
                ? 'wallet-muted'
                : rebuildMsg.startsWith('Rebuild complete')
                  ? 'text-green-400'
                  : 'text-red-400'
            }`}
          >
            {rebuildMsg}
          </p>
        )}
        <button
          type="button"
          disabled={rebuildBusy || !walletId}
          onClick={() => void handleRebuildWallet()}
          className="w-full rounded-xl border border-red-500/70 py-2.5 text-sm font-semibold text-red-400 hover:opacity-80 disabled:opacity-50"
        >
          {rebuildBusy ? 'Rebuilding…' : 'Rebuild Wallet from network'}
        </button>
      </div>
    </div>
  );
};
