import { useState, type FC } from 'react';

import { Network } from '../../../state/slices/networkSlice';
import {
  deriveWatchOnlyAccountPreview,
  type WatchOnlyAccountPreview,
} from './watchOnlyAccountPreview';
import { createWatchOnlyWallet } from './watchOnlyWallet';
import { CapacitorBarcodeScanner } from '../barcode-scanner';
import { CameraQrScanner } from '../CameraQrScanner';

type WatchOnlyWalletPreviewProps = {
  onBack: () => void;
  /** Called with the new wallet id once the wallet + derived addresses are persisted. */
  onCreated: (walletId: number) => void;
};

export const WatchOnlyWalletPreview: FC<WatchOnlyWalletPreviewProps> = ({
  onBack,
  onCreated,
}) => {
  const [network, setNetwork] = useState(Network.MAINNET);
  const [accountXpub, setAccountXpub] = useState('');
  const [masterFingerprint, setMasterFingerprint] = useState('');
  const [walletName, setWalletName] = useState('');
  const [preview, setPreview] = useState<WatchOnlyAccountPreview | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  const handleCreate = async () => {
    setBusy(true);
    setError('');
    try {
      const walletId = await createWatchOnlyWallet({
        name: walletName,
        accountXpub,
        network,
        masterFingerprint: masterFingerprint || undefined,
      });
      onCreated(walletId);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not save this watch-only wallet.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="min-h-[100dvh] wallet-surface flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-md space-y-4">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-bold wallet-text-strong">
            Create Watch-Only Wallet
          </h1>
          <p className="text-sm wallet-muted">
            Watch public BCH addresses without importing any private keys.
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
            Wallet name
            <input
              value={walletName}
              onChange={(event) => setWalletName(event.target.value)}
              placeholder="e.g. Cold storage watch"
              className="wallet-input w-full rounded-md px-3 py-2"
            />
          </label>
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
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setScanning(true)}
              className="flex-1 rounded-md border border-[var(--wallet-border)] py-2 text-sm font-semibold wallet-text-strong"
            >
              Scan (camera)
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  const { ScanResult } = await CapacitorBarcodeScanner.scanBarcode();
                  if (ScanResult) {
                    setAccountXpub(ScanResult.trim());
                    setPreview(null);
                    setError('');
                  }
                } catch (err) {
                  if (err instanceof Error && err.message !== 'No file selected') {
                    setError(err.message);
                  }
                }
              }}
              className="flex-1 rounded-md border border-[var(--wallet-border)] py-2 text-sm font-semibold wallet-text-strong"
            >
              Upload QR
            </button>
          </div>
          {scanning && (
            <CameraQrScanner
              onResult={(text) => {
                setAccountXpub(text);
                setPreview(null);
                setError('');
                setScanning(false);
              }}
              onClose={() => setScanning(false)}
            />
          )}
          <p className="text-[11px] leading-relaxed wallet-muted">
            Confirm that SeedCash exported this account at{' '}
            <span className="font-mono">
              m/44&apos;/145&apos;/account&apos;
            </span>
            . A standalone BIP32 xPub cannot prove its parent purpose or coin
            path.
          </p>
          <label className="block space-y-1 text-sm wallet-text-strong">
            Master fingerprint{' '}
            <span className="text-[11px] font-normal wallet-muted">
              (optional, but needed to send)
            </span>
            <input
              value={masterFingerprint}
              onChange={(event) => {
                setMasterFingerprint(event.target.value);
                setError('');
              }}
              placeholder="8 hex chars, e.g. 4c9a1f7b"
              maxLength={8}
              autoComplete="off"
              spellCheck={false}
              className="wallet-input w-full rounded-md px-3 py-2 font-mono text-sm uppercase"
            />
          </label>
          <p className="text-[11px] leading-relaxed wallet-muted">
            The signer prints this under the account xPub. The send flow embeds
            it in the unsigned transaction so the device can claim the inputs;
            without it the signer refuses. It can also be set later, when you
            first send.
          </p>
          <button
            type="button"
            onClick={handlePreview}
            className="wallet-btn-secondary w-full py-2 font-semibold"
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

        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={busy || !walletName.trim() || !accountXpub.trim() || !preview}
          className="wallet-btn-primary w-full py-2 font-semibold disabled:opacity-50"
        >
          {busy ? 'Saving wallet…' : 'Save watch-only wallet'}
        </button>
        <p className="text-[11px] leading-relaxed wallet-muted">
          Preview the public addresses above first — the wallet is saved only
          after you confirm they match what your device shows. The xPub is
          stored so addresses can be rebuilt after a restart; nothing secret is
          saved, signatures always come from the device (e.g. SeedCash).
        </p>

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
