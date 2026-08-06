import { useState, type FC } from 'react';

import { Network } from '../../../state/slices/networkSlice';
import { createWatchOnlyWallet } from './watchOnlyWallet';
import { deriveWatchOnlyAccountPreview } from './watchOnlyAccountPreview';
import {
  isBchAccountPath,
  parseKeystoneAccount,
  type KeystoneAccount,
} from '../../../services/psbt/keystoneAccount';
import { signerProfile } from '../../../services/psbt/signerProfiles';
import { CameraQrScanner } from '../CameraQrScanner';

type KeystoneWalletSetupProps = {
  onBack: () => void;
  /** Called with the new wallet id once it is persisted, to open it. */
  onCreated: (walletId: number) => void;
};

/**
 * Set up a watch-only wallet from a Keystone account export.
 *
 * This is the same wallet the SeedCash path produces — public keys only, every
 * signature from the device. It gets its own screen because the import is
 * genuinely shorter: a Keystone account QR is a BC-UR structure carrying the
 * xPub, the master fingerprint and the derivation path, so there is nothing to
 * type and nothing to assume. The SeedCash flow has to ask for a fingerprint
 * and take the account path on trust because its export is a bare xPub.
 */
export const KeystoneWalletSetup: FC<KeystoneWalletSetupProps> = ({
  onBack,
  onCreated,
}) => {
  const profile = signerProfile('keystone');
  const [network, setNetwork] = useState(Network.MAINNET);
  const [walletName, setWalletName] = useState('');
  const [scanning, setScanning] = useState(false);
  const [frames, setFrames] = useState<string[]>([]);
  const [account, setAccount] = useState<KeystoneAccount | null>(null);
  const [firstAddress, setFirstAddress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /** Feed one scanned frame in; a multi-part export completes over several. */
  const handleFrame = (text: string) => {
    const next = [...frames, text.trim()];
    setFrames(next);
    try {
      const parsed = parseKeystoneAccount(next);
      // Derived here rather than on save so the user confirms a real address
      // from their own device before anything is written.
      const preview = deriveWatchOnlyAccountPreview(network, parsed.xpub);
      setAccount(parsed);
      setFirstAddress(preview.receive.address);
      setScanning(false);
      setError('');
    } catch (err) {
      // Partial scans are the normal case mid-animation, not a failure.
      const message = err instanceof Error ? err.message : String(err);
      if (/part of the animated/i.test(message)) return;
      setFrames([]);
      setAccount(null);
      setError(message);
      setScanning(false);
    }
  };

  const handleCreate = async () => {
    if (!account) return;
    setBusy(true);
    setError('');
    try {
      const walletId = await createWatchOnlyWallet({
        name: walletName,
        accountXpub: account.xpub,
        network,
        accountPath: account.accountPath,
        masterFingerprint: account.masterFingerprintHex,
      });
      onCreated(walletId);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not save this wallet.'
      );
    } finally {
      setBusy(false);
    }
  };

  const wrongChain = account ? !isBchAccountPath(account.accountPath) : false;

  return (
    <section className="min-h-[100dvh] wallet-surface flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-md space-y-4">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-bold wallet-text-strong">
            Set up Keystone
          </h1>
          <p className="text-sm wallet-muted">
            On the device, open the Bitcoin Cash account and show its export QR.
          </p>
        </div>

        <div className="wallet-card space-y-3 p-4">
          <label className="block space-y-1 text-sm wallet-text-strong">
            Wallet name
            <input
              value={walletName}
              onChange={(event) => setWalletName(event.target.value)}
              placeholder="e.g. Keystone cold"
              className="wallet-input w-full rounded-md px-3 py-2"
            />
          </label>
          <label className="block space-y-1 text-sm wallet-text-strong">
            Network
            <select
              value={network}
              onChange={(event) => {
                setNetwork(event.target.value as Network);
                setAccount(null);
                setFrames([]);
                setError('');
              }}
              className="wallet-input w-full rounded-md px-3 py-2"
            >
              <option value={Network.MAINNET}>Mainnet</option>
              <option value={Network.CHIPNET}>Chipnet</option>
            </select>
          </label>

          {!account && (
            <button
              type="button"
              onClick={() => {
                setFrames([]);
                setError('');
                setScanning(true);
              }}
              className="wallet-btn-primary w-full py-2 font-semibold"
            >
              Scan the account QR
            </button>
          )}

          {scanning && (
            <>
              <CameraQrScanner
                onResult={handleFrame}
                onClose={() => setScanning(false)}
              />
              <p className="text-center text-[11px] wallet-muted">
                Hold steady — the export may animate across several frames.
              </p>
            </>
          )}

          {error && (
            <p role="alert" className="text-xs text-red-400">
              {error}
            </p>
          )}
        </div>

        {account && (
          <div className="wallet-card space-y-3 p-4">
            <p className="text-sm font-semibold wallet-text-strong">
              Read from the device
            </p>
            <dl className="space-y-1.5 text-[11px]">
              <div className="flex justify-between gap-2">
                <dt className="wallet-muted">Account path</dt>
                <dd className="font-mono wallet-text-strong">
                  {account.accountPath}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="wallet-muted">Master fingerprint</dt>
                <dd className="font-mono wallet-text-strong">
                  {account.masterFingerprintHex.toUpperCase()}
                </dd>
              </div>
            </dl>
            <div className="space-y-1">
              <p className="text-[11px] wallet-muted">First receive address</p>
              <p className="break-all font-mono text-xs wallet-text-strong">
                {firstAddress}
              </p>
            </div>
            <p className="text-[11px] leading-relaxed wallet-muted">
              Check this address matches the one the device shows before you
              save. Nothing was typed in, so if it matches, the wallet is
              watching exactly the account on that Keystone.
            </p>

            {wrongChain && (
              <p className="text-[11px] leading-relaxed text-amber-400">
                That account is at {account.accountPath}, which is not a
                Bitcoin Cash path. It will produce valid-looking addresses that
                never show a Bitcoin Cash balance — on the device, pick the
                Bitcoin Cash account instead.
              </p>
            )}

            {!profile.signingVerified && profile.signingCaveat && (
              <p className="text-[11px] leading-relaxed text-amber-400">
                {profile.signingCaveat}
              </p>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={busy || !account || !walletName.trim()}
          className="wallet-btn-primary w-full py-2 font-semibold disabled:opacity-50"
        >
          {busy ? 'Saving wallet…' : 'Save and open wallet'}
        </button>

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

export default KeystoneWalletSetup;
