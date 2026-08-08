/**
 * Create Watch-Only Wallet (PSBT path).
 *
 * One form card: name, network, single-sig xPub or Multisig cosigners, password.
 * Save and open — no address preview step.
 * Bottom: separate Airgap section (Keystone only for now).
 */

import { useState, type FC } from 'react';
import { lockingBytecodeToCashAddress } from '@bitauth/libauth';

import { Network } from '../../../state/slices/networkSlice';
import DatabaseService from '../../../apis/DatabaseManager/DatabaseService';
import WalletManager from '../../../apis/WalletManager/WalletManager';
import {
  createWatchOnlyMultisigWallet,
  createWatchOnlyWallet,
} from './watchOnlyWallet';
import { protectWatchOnlyWithPassword } from '../DesktopWalletManager';
import { getBchAccountPath } from '../../../services/HdWalletService';
import {
  deriveMultisigAddress,
  MAX_COSIGNERS,
  parsePmwif,
  pmwifFilename,
  serializePmwif,
  type MultisigPolicy,
} from '../../../services/psbt/multisigWallet';
import {
  isBchAccountPath,
  parseKeystoneAccount,
  type KeystoneAccount,
} from '../../../services/psbt/keystoneAccount';
import { CapacitorBarcodeScanner } from '../barcode-scanner';
import { CameraQrScanner } from '../CameraQrScanner';

const MULTISIG_PRESETS = [
  [2, 2],
  [2, 3],
  [3, 5],
] as const;

async function rollbackCreatedWallet(walletId: number | null): Promise<void> {
  if (walletId == null) return;
  try {
    await WalletManager().deleteWallet(walletId);
    await DatabaseService().deleteWalletFromFile(walletId);
  } catch (rollbackError) {
    console.error(
      '[WatchOnlyWalletPreview] Failed to roll back wallet creation:',
      rollbackError
    );
  }
}

type CosignerDraft = { name: string; xpub: string; fingerprint: string };
type PsbtMode = 'standard' | 'multisig';

type WatchOnlyWalletPreviewProps = {
  onBack: () => void;
  onCreated: (walletId: number) => void;
};

export const WatchOnlyWalletPreview: FC<WatchOnlyWalletPreviewProps> = ({
  onBack,
  onCreated,
}) => {
  // main = PSBT watch-only card; keystone = airgap Keystone form
  const [panel, setPanel] = useState<'main' | 'keystone'>('main');
  const [mode, setMode] = useState<PsbtMode>('standard');

  const [network, setNetwork] = useState(Network.MAINNET);
  const [walletName, setWalletName] = useState('');
  const [accountXpub, setAccountXpub] = useState('');
  const [scanning, setScanning] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Multisig
  const [required, setRequired] = useState(2);
  const [cosigners, setCosigners] = useState<CosignerDraft[]>([
    { name: '', xpub: '', fingerprint: '' },
    { name: '', xpub: '', fingerprint: '' },
  ]);
  const [scanningCosigner, setScanningCosigner] = useState<number | null>(null);

  // Keystone airgap
  const [keystoneFrames, setKeystoneFrames] = useState<string[]>([]);
  const [keystoneAccount, setKeystoneAccount] =
    useState<KeystoneAccount | null>(null);
  const [keystoneScanning, setKeystoneScanning] = useState(false);

  const requirePassword = (): boolean => {
    if (password.length < 8) {
      setError('Choose a password of at least 8 characters.');
      return false;
    }
    if (password !== passwordConfirm) {
      setError('Passwords do not match.');
      return false;
    }
    return true;
  };

  const draftPolicy = (): MultisigPolicy => ({
    name: walletName.trim() || 'Multisig',
    m: required,
    signers: cosigners.map((c, i) => ({
      name: c.name.trim() || `Cosigner ${i + 1}`,
      xpub: c.xpub.trim(),
      masterFingerprintHex: c.fingerprint.trim()
        ? c.fingerprint.trim().toLowerCase()
        : undefined,
    })),
  });

  const applyPreset = (m: number, n: number) => {
    setCosigners((prev) => {
      const next = prev.slice(0, n);
      while (next.length < n) next.push({ name: '', xpub: '', fingerprint: '' });
      return next;
    });
    setRequired(m);
    setError('');
  };

  const patchCosigner = (index: number, patch: Partial<CosignerDraft>) => {
    setCosigners((prev) =>
      prev.map((c, at) => (at === index ? { ...c, ...patch } : c))
    );
    setError('');
  };

  const handleCreateStandard = async () => {
    if (!walletName.trim()) {
      setError('Give the wallet a name.');
      return;
    }
    if (!accountXpub.trim()) {
      setError('Paste or scan the account xPub.');
      return;
    }
    if (!requirePassword()) return;

    setBusy(true);
    setError('');
    let walletId: number | null = null;
    try {
      walletId = await createWatchOnlyWallet({
        name: walletName,
        accountXpub,
        network,
        accountPath: getBchAccountPath(network),
      });
      await protectWatchOnlyWithPassword(walletId, password);
      onCreated(walletId);
    } catch (err) {
      await rollbackCreatedWallet(walletId);
      setError(
        err instanceof Error
          ? err.message
          : 'Could not save this watch-only wallet.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleCreateMultisig = async () => {
    if (!walletName.trim()) {
      setError('Give the wallet a name.');
      return;
    }
    if (!requirePassword()) return;

    setBusy(true);
    setError('');
    let walletId: number | null = null;
    try {
      const policy = draftPolicy();
      const prefix =
        network === Network.MAINNET ? 'bitcoincash' : ('bchtest' as const);
      const derived = deriveMultisigAddress(policy, 0, 0);
      const encoded = lockingBytecodeToCashAddress({
        bytecode: derived.lockingBytecode,
        prefix,
      });
      if (typeof encoded === 'string' || !('address' in encoded)) {
        throw new Error(
          'Could not build a multisig address from these cosigners.'
        );
      }
      walletId = await createWatchOnlyMultisigWallet({
        name: walletName,
        policy,
        network,
      });
      await protectWatchOnlyWithPassword(walletId, password);
      onCreated(walletId);
    } catch (err) {
      await rollbackCreatedWallet(walletId);
      setError(
        err instanceof Error ? err.message : 'Could not save this wallet.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleKeystoneFrame = (text: string) => {
    const next = [...keystoneFrames, text.trim()];
    setKeystoneFrames(next);
    try {
      const parsed = parseKeystoneAccount(next);
      setKeystoneAccount(parsed);
      setKeystoneScanning(false);
      setError('');
      if (!walletName.trim()) setWalletName('Keystone');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/part of the animated/i.test(message)) return;
      setKeystoneFrames([]);
      setKeystoneAccount(null);
      setError(message);
      setKeystoneScanning(false);
    }
  };

  const handleCreateKeystone = async () => {
    if (!walletName.trim()) {
      setError('Give the wallet a name.');
      return;
    }
    if (!keystoneAccount) {
      setError('Scan the Keystone account QR first.');
      return;
    }
    if (!isBchAccountPath(keystoneAccount.accountPath)) {
      setError(
        `That account is at ${keystoneAccount.accountPath}, which is not a Bitcoin Cash path. Pick the BCH account on the device.`
      );
      return;
    }
    if (!requirePassword()) return;

    setBusy(true);
    setError('');
    let walletId: number | null = null;
    try {
      walletId = await createWatchOnlyWallet({
        name: walletName,
        accountXpub: keystoneAccount.xpub,
        network,
        accountPath: keystoneAccount.accountPath,
        masterFingerprint: keystoneAccount.masterFingerprintHex,
      });
      await protectWatchOnlyWithPassword(walletId, password);
      onCreated(walletId);
    } catch (err) {
      await rollbackCreatedWallet(walletId);
      setError(
        err instanceof Error ? err.message : 'Could not save this wallet.'
      );
    } finally {
      setBusy(false);
    }
  };

  // —— Keystone airgap (from Airgap section) ——
  if (panel === 'keystone') {
    const canSave =
      Boolean(walletName.trim()) &&
      keystoneAccount != null &&
      password.length >= 8 &&
      password === passwordConfirm &&
      !busy;

    return (
      <section className="min-h-[100dvh] wallet-surface flex flex-col items-center px-4 py-10">
        <div className="w-full max-w-md space-y-4">
          <div className="space-y-1 text-center">
            <p className="text-[11px] uppercase tracking-wide wallet-muted">
              Airgap · inside watch-only
            </p>
            <h1 className="text-xl font-bold wallet-text-strong">Keystone</h1>
            <p className="text-sm wallet-muted">
              Scan account QR (path + fingerprint). Send &amp; receive airgap —
              not USB, not PSBT.
            </p>
          </div>

          <div className="wallet-card space-y-4 p-4">
            <label className="block space-y-1 text-sm wallet-text-strong">
              Wallet name
              <input
                value={walletName}
                onChange={(e) => {
                  setWalletName(e.target.value);
                  setError('');
                }}
                placeholder="e.g. Keystone cold"
                className="wallet-input w-full rounded-md px-3 py-2"
              />
            </label>
            <label className="block space-y-1 text-sm wallet-text-strong">
              Network
              <select
                value={network}
                onChange={(e) => {
                  setNetwork(e.target.value as Network);
                  setKeystoneAccount(null);
                  setKeystoneFrames([]);
                  setError('');
                }}
                className="wallet-input w-full rounded-md px-3 py-2"
              >
                <option value={Network.MAINNET}>Mainnet</option>
                <option value={Network.CHIPNET}>Chipnet</option>
              </select>
            </label>

            {!keystoneAccount ? (
              <button
                type="button"
                onClick={() => {
                  setKeystoneFrames([]);
                  setError('');
                  setKeystoneScanning(true);
                }}
                className="wallet-btn-primary w-full py-2 font-semibold"
              >
                Scan Keystone account QR
              </button>
            ) : (
              <div className="space-y-2 text-[11px]">
                <p className="text-sm font-semibold wallet-text-strong">
                  Account from device
                </p>
                <div className="flex justify-between gap-2">
                  <span className="wallet-muted">Path</span>
                  <span className="font-mono wallet-text-strong">
                    {keystoneAccount.accountPath}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="wallet-muted">Fingerprint</span>
                  <span className="font-mono wallet-text-strong">
                    {keystoneAccount.masterFingerprintHex.toUpperCase()}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setKeystoneAccount(null);
                    setKeystoneFrames([]);
                  }}
                  className="text-[11px] underline wallet-muted"
                >
                  Scan again
                </button>
              </div>
            )}
            {keystoneScanning && (
              <>
                <CameraQrScanner
                  onResult={handleKeystoneFrame}
                  onClose={() => setKeystoneScanning(false)}
                />
                <p className="text-center text-[11px] wallet-muted">
                  Hold steady — the export may animate across several frames.
                </p>
              </>
            )}

            <div className="border-t border-[var(--wallet-border)] pt-3 space-y-3">
              <p className="text-sm font-semibold wallet-text-strong">Password</p>
              <p className="text-[11px] leading-relaxed wallet-muted">
                Required every time you Open this wallet from the list. Private
                keys are never stored here.
              </p>
              <label className="block space-y-1 text-sm wallet-text-strong">
                Password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError('');
                  }}
                  placeholder="At least 4 characters"
                  className="wallet-input w-full rounded-md px-3 py-2"
                />
              </label>
              <label className="block space-y-1 text-sm wallet-text-strong">
                Confirm password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={passwordConfirm}
                  onChange={(e) => {
                    setPasswordConfirm(e.target.value);
                    setError('');
                  }}
                  placeholder="Repeat password"
                  className="wallet-input w-full rounded-md px-3 py-2"
                />
              </label>
            </div>
          </div>

          {error && (
            <p role="alert" className="text-xs text-red-400">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => void handleCreateKeystone()}
            disabled={!canSave}
            className="wallet-btn-primary w-full py-2 font-semibold disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save and open wallet'}
          </button>
          <button
            type="button"
            onClick={() => {
              setPanel('main');
              setError('');
              setKeystoneAccount(null);
              setKeystoneFrames([]);
            }}
            className="wallet-btn-secondary w-full py-2 text-sm"
          >
            Back to watch-only
          </button>
        </div>
      </section>
    );
  }

  // —— Main PSBT watch-only (single-sig / multisig) ——
  const canSaveStandard =
    Boolean(walletName.trim()) &&
    Boolean(accountXpub.trim()) &&
    password.length >= 8 &&
    password === passwordConfirm &&
    !busy;

  const canSaveMultisig =
    Boolean(walletName.trim()) &&
    cosigners.every((c) => c.xpub.trim()) &&
    password.length >= 8 &&
    password === passwordConfirm &&
    !busy;

  return (
    <section className="min-h-[100dvh] wallet-surface flex flex-col items-center px-4 py-10">
      <div className="w-full max-w-md space-y-4">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-bold wallet-text-strong">
            Create Watch-Only Wallet
          </h1>
          <p className="text-sm wallet-muted">
            PSBT airgap (SeedCash-style). Public keys only — save under a
            password and open.
          </p>
        </div>

        {/* Single-sig vs Multisig for PSBT */}
        <div
          className="grid grid-cols-2 gap-2"
          aria-label="Watch-only PSBT type"
        >
          <button
            type="button"
            onClick={() => {
              setMode('standard');
              setError('');
            }}
            className={`wallet-card p-3 text-left ${
              mode === 'standard' ? 'border-[var(--wallet-accent)]' : ''
            }`}
          >
            <p className="text-sm font-semibold wallet-text-strong">
              Single-sig
            </p>
            <p className="mt-1 text-[11px] wallet-muted">One account xPub</p>
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('multisig');
              setError('');
            }}
            className={`wallet-card p-3 text-left ${
              mode === 'multisig' ? 'border-[var(--wallet-accent)]' : ''
            }`}
          >
            <p className="text-sm font-semibold wallet-text-strong">Multisig</p>
            <p className="mt-1 text-[11px] wallet-muted">m-of-n cosigners</p>
          </button>
        </div>

        {/* One big card: name, network, keys, password */}
        <div className="wallet-card space-y-4 p-4">
          <label className="block space-y-1 text-sm wallet-text-strong">
            Wallet name
            <input
              value={walletName}
              onChange={(e) => {
                setWalletName(e.target.value);
                setError('');
              }}
              placeholder="e.g. Cold storage"
              className="wallet-input w-full rounded-md px-3 py-2"
            />
          </label>

          <label className="block space-y-1 text-sm wallet-text-strong">
            Network
            <select
              value={network}
              onChange={(e) => {
                setNetwork(e.target.value as Network);
                setError('');
              }}
              className="wallet-input w-full rounded-md px-3 py-2"
            >
              <option value={Network.MAINNET}>Mainnet</option>
              <option value={Network.CHIPNET}>Chipnet</option>
            </select>
          </label>

          {mode === 'standard' && (
            <>
              <label className="block space-y-1 text-sm wallet-text-strong">
                Account xPub
                <textarea
                  value={accountXpub}
                  onChange={(e) => {
                    setAccountXpub(e.target.value);
                    setError('');
                  }}
                  rows={3}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste or scan the account xPub"
                  className="wallet-input w-full resize-none rounded-md px-3 py-2 font-mono text-xs"
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setScanning(true)}
                  className="flex-1 rounded-md border border-[var(--wallet-border)] py-2 text-sm font-semibold wallet-text-strong"
                >
                  Scan
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const { ScanResult } =
                        await CapacitorBarcodeScanner.scanBarcode();
                      if (ScanResult) {
                        setAccountXpub(ScanResult.trim());
                        setError('');
                      }
                    } catch (err) {
                      if (
                        err instanceof Error &&
                        err.message !== 'No file selected'
                      ) {
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
                    setAccountXpub(text.trim());
                    setScanning(false);
                    setError('');
                  }}
                  onClose={() => setScanning(false)}
                />
              )}
            </>
          )}

          {mode === 'multisig' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold wallet-text-strong">
                  Cosigners
                </p>
                <label className="text-[11px] wallet-muted">
                  <span className="mr-1">Load</span>
                  <input
                    type="file"
                    accept=".pmwif,application/json"
                    className="hidden"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (!file) return;
                      try {
                        const policy = parsePmwif(await file.text());
                        setWalletName((n) => n || policy.name);
                        setRequired(policy.m);
                        setCosigners(
                          policy.signers.map((s) => ({
                            name: s.name,
                            xpub: s.xpub,
                            fingerprint: s.masterFingerprintHex ?? '',
                          }))
                        );
                        setError('');
                      } catch (err) {
                        setError(
                          err instanceof Error
                            ? err.message
                            : 'Could not read that file.'
                        );
                      }
                    }}
                  />
                  <span className="cursor-pointer underline">.pmwif</span>
                </label>
              </div>
              <label className="block space-y-1 text-sm wallet-text-strong">
                Policy
                <select
                  value={`${required}-${cosigners.length}`}
                  onChange={(e) => {
                    const [m, n] = e.target.value.split('-').map(Number);
                    applyPreset(m, n);
                  }}
                  className="wallet-input w-full rounded-md px-3 py-2"
                >
                  {MULTISIG_PRESETS.map(([m, n]) => (
                    <option key={`${m}-${n}`} value={`${m}-${n}`}>
                      {m} of {n}
                    </option>
                  ))}
                  {!MULTISIG_PRESETS.some(
                    ([m, n]) => m === required && n === cosigners.length
                  ) && (
                    <option value={`${required}-${cosigners.length}`}>
                      {required} of {cosigners.length}
                    </option>
                  )}
                </select>
              </label>
              {cosigners.map((c, index) => (
                <div
                  key={index}
                  className="space-y-2 rounded-md border border-[var(--wallet-border)] p-3"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-semibold wallet-text-strong">
                      Cosigner {index + 1}
                    </p>
                    {cosigners.length > 2 && (
                      <button
                        type="button"
                        onClick={() =>
                          setCosigners(cosigners.filter((_, at) => at !== index))
                        }
                        className="text-[11px] text-red-400"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <input
                    value={c.name}
                    onChange={(e) =>
                      patchCosigner(index, { name: e.target.value })
                    }
                    placeholder="Name"
                    className="wallet-input w-full rounded-md px-3 py-2 text-sm"
                  />
                  <textarea
                    value={c.xpub}
                    onChange={(e) =>
                      patchCosigner(index, { xpub: e.target.value })
                    }
                    rows={2}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="Account xPub"
                    className="wallet-input w-full resize-none rounded-md px-3 py-2 font-mono text-[11px]"
                  />
                  <div className="flex gap-2">
                    <input
                      value={c.fingerprint}
                      onChange={(e) =>
                        patchCosigner(index, { fingerprint: e.target.value })
                      }
                      placeholder="Fingerprint (optional)"
                      maxLength={8}
                      className="wallet-input flex-1 rounded-md px-3 py-2 font-mono text-[11px] uppercase"
                    />
                    <button
                      type="button"
                      onClick={() => setScanningCosigner(index)}
                      className="rounded-md border border-[var(--wallet-border)] px-3 text-[11px] font-semibold"
                    >
                      Scan
                    </button>
                  </div>
                  {scanningCosigner === index && (
                    <CameraQrScanner
                      onResult={(text) => {
                        patchCosigner(index, { xpub: text.trim() });
                        setScanningCosigner(null);
                      }}
                      onClose={() => setScanningCosigner(null)}
                    />
                  )}
                </div>
              ))}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={cosigners.length >= MAX_COSIGNERS}
                  onClick={() =>
                    setCosigners([
                      ...cosigners,
                      { name: '', xpub: '', fingerprint: '' },
                    ])
                  }
                  className="wallet-btn-secondary flex-1 py-2 text-sm disabled:opacity-50"
                >
                  Add cosigner
                </button>
                <button
                  type="button"
                  onClick={() => {
                    try {
                      const policy = draftPolicy();
                      const blob = new Blob([serializePmwif(policy)], {
                        type: 'application/json',
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = pmwifFilename(policy);
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch (err) {
                      setError(
                        err instanceof Error
                          ? err.message
                          : 'Could not export policy.'
                      );
                    }
                  }}
                  className="wallet-btn-secondary flex-1 py-2 text-sm"
                >
                  Export .pmwif
                </button>
              </div>
            </div>
          )}

          {/* Password block — same card */}
          <div className="border-t border-[var(--wallet-border)] pt-3 space-y-3">
            <p className="text-sm font-semibold wallet-text-strong">Password</p>
            <p className="text-[11px] leading-relaxed wallet-muted">
              Required every time you Open this wallet from the list. Private
              keys are never stored here.
            </p>
            <label className="block space-y-1 text-sm wallet-text-strong">
              Password
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError('');
                }}
                placeholder="At least 4 characters"
                className="wallet-input w-full rounded-md px-3 py-2"
              />
            </label>
            <label className="block space-y-1 text-sm wallet-text-strong">
              Confirm password
              <input
                type="password"
                autoComplete="new-password"
                value={passwordConfirm}
                onChange={(e) => {
                  setPasswordConfirm(e.target.value);
                  setError('');
                }}
                placeholder="Repeat password"
                className="wallet-input w-full rounded-md px-3 py-2"
              />
            </label>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={() =>
            void (mode === 'multisig'
              ? handleCreateMultisig()
              : handleCreateStandard())
          }
          disabled={mode === 'multisig' ? !canSaveMultisig : !canSaveStandard}
          className="wallet-btn-primary w-full py-2 font-semibold disabled:opacity-50"
        >
          {busy
            ? 'Saving…'
            : mode === 'multisig'
              ? `Save ${required}-of-${cosigners.length} and open`
              : 'Save and open wallet'}
        </button>

        {/* Airgap — separate section at bottom, Keystone only */}
        <div className="pt-4 space-y-2 border-t border-[var(--wallet-border)]">
          <div className="space-y-0.5 px-0.5">
            <p className="text-sm font-semibold wallet-text-strong">Airgap</p>
            <p className="text-[11px] leading-relaxed wallet-muted">
              Not PSBT. Device stays offline; send &amp; receive over QR airgap.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setPanel('keystone');
              setError('');
              setPassword('');
              setPasswordConfirm('');
            }}
            className="wallet-card w-full p-3 text-left transition hover:border-[var(--wallet-accent)]"
          >
            <p className="text-sm font-semibold wallet-text-strong">Keystone</p>
            <p className="mt-1 text-[11px] leading-relaxed wallet-muted">
              Scan account QR (path + fingerprint). Send &amp; receive airgap —
              not USB, not PSBT.
            </p>
          </button>
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

export default WatchOnlyWalletPreview;
