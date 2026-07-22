import { useState, type FC } from 'react';

import { Network } from '../../../state/slices/networkSlice';
import {
  deriveWatchOnlyAccountPreview,
  type WatchOnlyAccountPreview,
} from './watchOnlyAccountPreview';

type WatchOnlyWalletPreviewProps = {
  onBack: () => void;
};

export const WatchOnlyWalletPreview: FC<WatchOnlyWalletPreviewProps> = ({
  onBack,
}) => {
  const [network, setNetwork] = useState(Network.MAINNET);
  const [accountXpub, setAccountXpub] = useState('');
  const [preview, setPreview] = useState<WatchOnlyAccountPreview | null>(null);
  const [error, setError] = useState('');

  const handlePreview = () => {
    try {
      setPreview(deriveWatchOnlyAccountPreview(network, accountXpub));
      setError('');
    } catch (err) {
      setPreview(null);
      setError(
        err instanceof Error ? err.message : 'Could not preview this xPub.'
      );
    }
  };

  return (
    <section className="min-h-[100dvh] wallet-surface flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-md space-y-4">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-bold wallet-text-strong">
            Watch-Only Wallet Preview
          </h1>
          <p className="text-sm wallet-muted">
            Inspect public BCH addresses without importing any private keys.
          </p>
        </div>

        <div
          className="grid grid-cols-2 gap-2"
          aria-label="Watch-only wallet type"
        >
          <div className="wallet-card border-[var(--wallet-accent)] p-3">
            <p className="text-sm font-semibold wallet-text-strong">Standard</p>
            <p className="mt-1 text-[11px] wallet-muted">Account xPub</p>
          </div>
          <div className="wallet-card p-3 opacity-60" aria-disabled="true">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold wallet-text-strong">
                Multisign
              </p>
              <span className="text-[9px] wallet-muted">Coming next</span>
            </div>
            <p className="mt-1 text-[11px] wallet-muted">Multiple cosigners</p>
          </div>
        </div>

        <div className="wallet-card space-y-3 p-4">
          <label className="block space-y-1 text-sm wallet-text-strong">
            Network
            <select
              value={network}
              onChange={(event) => {
                setNetwork(event.target.value as Network);
                setPreview(null);
                setError('');
              }}
              className="wallet-input w-full rounded-md px-3 py-2"
            >
              <option value={Network.MAINNET}>Mainnet</option>
              <option value={Network.CHIPNET}>Chipnet</option>
            </select>
          </label>
          <label className="block space-y-1 text-sm wallet-text-strong">
            BCH account xPub
            <textarea
              value={accountXpub}
              onChange={(event) => {
                setAccountXpub(event.target.value);
                setPreview(null);
                setError('');
              }}
              rows={3}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the xPub exported by SeedCash"
              className="wallet-input w-full resize-none rounded-md px-3 py-2 font-mono text-xs"
            />
          </label>
          <p className="text-[11px] leading-relaxed wallet-muted">
            Confirm that SeedCash exported this account at{' '}
            <span className="font-mono">
              m/44&apos;/145&apos;/account&apos;
            </span>
            . A standalone BIP32 xPub cannot prove its parent purpose or coin
            path.
          </p>
          <button
            type="button"
            onClick={handlePreview}
            className="wallet-btn-primary w-full py-2 font-semibold"
          >
            Preview public addresses
          </button>
          {error && (
            <p role="alert" className="text-xs text-red-400">
              {error}
            </p>
          )}
        </div>

        {preview && (
          <div className="wallet-card space-y-3 p-4">
            <p className="text-sm font-semibold wallet-text-strong">
              Public address preview
            </p>
            {(
              [
                ['Receive #0', preview.receive],
                ['Change #0', preview.change],
              ] as const
            ).map(([label, item]) => (
              <div key={label} className="space-y-1">
                <p className="text-[11px] wallet-muted">
                  {label} · <span className="font-mono">{item.path}</span>
                </p>
                <p className="break-all font-mono text-xs wallet-text-strong">
                  {item.address}
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-300">
          Public preview only: this screen does not save a watch-only wallet or
          create, sign, import, or broadcast PSBT transactions yet.
        </div>
        <button
          type="button"
          onClick={onBack}
          className="wallet-btn-secondary w-full py-2 text-sm"
        >
          Back to wallets
        </button>
      </div>
    </section>
  );
};
