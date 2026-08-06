import { useState, type FC } from 'react';

import { Network } from '../../../state/slices/networkSlice';
import {
  deriveWatchOnlyAccountPreview,
  type WatchOnlyAccountPreview,
} from './watchOnlyAccountPreview';
import {
  createWatchOnlyMultisigWallet,
  createWatchOnlyWallet,
} from './watchOnlyWallet';
import {
  cosignersMissingFingerprint,
  deriveMultisigAddress,
  MAX_COSIGNERS,
  parsePmwif,
  pmwifFilename,
  serializePmwif,
  type MultisigPolicy,
} from '../../../services/psbt/multisigWallet';
import { lockingBytecodeToCashAddress } from '@bitauth/libauth';

/** The policies people actually use, in the order they are usually wanted. */
const MULTISIG_PRESETS = [
  [2, 2],
  [2, 3],
  [3, 5],
] as const;

type CosignerDraft = { name: string; xpub: string; fingerprint: string };
type MultisigPreview = {
  receive: string;
  change: string;
  missingFingerprints: number;
};
import { CapacitorBarcodeScanner } from '../barcode-scanner';
import { CameraQrScanner } from '../CameraQrScanner';

type WatchOnlyWalletPreviewProps = {
  onBack: () => void;
  /** Called with the new wallet id once the wallet + derived addresses are persisted. */
  onCreated: (walletId: number) => void;
};

/**
 * Cosigner set editor for a Multisign watch-only wallet.
 *
 * The order cosigners are entered in does not matter: every address BIP-67
 * sorts the derived keys, which is what lets each participant assemble the
 * same wallet independently. The threshold does matter, and so does the exact
 * set — one different xPub is a different wallet with different addresses,
 * which is why the address preview is a required confirmation step before the
 * wallet is saved.
 */
const MultisigCosignerForm: FC<{
  required: number;
  setRequired: (value: number) => void;
  cosigners: CosignerDraft[];
  setCosigners: (next: CosignerDraft[]) => void;
  patchCosigner: (index: number, patch: Partial<CosignerDraft>) => void;
  applyPreset: (m: number, n: number) => void;
  scanningCosigner: number | null;
  setScanningCosigner: (index: number | null) => void;
  onPreview: () => void;
  onImport: (file: File) => void;
  onExport: () => void;
  preview: MultisigPreview | null;
  error: string;
}> = ({
  required,
  setRequired,
  cosigners,
  setCosigners,
  patchCosigner,
  applyPreset,
  scanningCosigner,
  setScanningCosigner,
  onPreview,
  onImport,
  onExport,
  preview,
  error,
}) => {
  const [custom, setCustom] = useState(false);
  return (
  <div className="wallet-card space-y-3 p-4">
    <div className="flex items-center justify-between gap-2">
      <p className="text-sm font-semibold wallet-text-strong">Cosigners</p>
      <label className="text-[11px] wallet-muted">
        <span className="mr-1">Load a wallet file</span>
        <input
          type="file"
          accept=".pmwif,application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onImport(file);
            event.target.value = '';
          }}
        />
        <span className="cursor-pointer underline">.pmwif</span>
      </label>
    </div>

    <label className="block space-y-1 text-sm wallet-text-strong">
      Policy
      <select
        value={custom ? 'custom' : `${required}-${cosigners.length}`}
        onChange={(event) => {
          if (event.target.value === 'custom') {
            setCustom(true);
            return;
          }
          setCustom(false);
          const [m, n] = event.target.value.split('-').map(Number);
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
        <option value="custom">Custom…</option>
      </select>
    </label>

    {custom && (
      <label className="block space-y-1 text-sm wallet-text-strong">
        Signatures required
        <select
          value={required}
          onChange={(event) => setRequired(Number(event.target.value))}
          className="wallet-input w-full rounded-md px-3 py-2"
        >
          {Array.from(
            { length: cosigners.length },
            (_, index) => index + 1
          ).map((value) => (
            <option key={value} value={value}>
              {value} of {cosigners.length}
            </option>
          ))}
        </select>
      </label>
    )}

    {cosigners.map((cosigner, index) => (
      <div key={index} className="space-y-2 rounded-md border border-[var(--wallet-border)] p-3">
        <div className="flex items-center justify-between gap-2">
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
          value={cosigner.name}
          onChange={(event) => patchCosigner(index, { name: event.target.value })}
          placeholder={`Name (e.g. Alice's SeedCash)`}
          className="wallet-input w-full rounded-md px-3 py-2 text-sm"
        />
        <textarea
          value={cosigner.xpub}
          onChange={(event) => patchCosigner(index, { xpub: event.target.value })}
          rows={2}
          spellCheck={false}
          autoComplete="off"
          placeholder="Account xPub"
          className="wallet-input w-full resize-none rounded-md px-3 py-2 font-mono text-[11px]"
        />
        <div className="flex gap-2">
          <input
            value={cosigner.fingerprint}
            onChange={(event) =>
              patchCosigner(index, { fingerprint: event.target.value })
            }
            placeholder="Fingerprint (optional)"
            maxLength={8}
            spellCheck={false}
            autoComplete="off"
            className="wallet-input flex-1 rounded-md px-3 py-2 font-mono text-[11px] uppercase"
          />
          <button
            type="button"
            onClick={() => setScanningCosigner(index)}
            className="rounded-md border border-[var(--wallet-border)] px-3 text-[11px] font-semibold wallet-text-strong"
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
          setCosigners([...cosigners, { name: '', xpub: '', fingerprint: '' }])
        }
        className="wallet-btn-secondary flex-1 py-2 text-sm disabled:opacity-50"
      >
        Add cosigner
      </button>
      <button
        type="button"
        onClick={onExport}
        className="wallet-btn-secondary flex-1 py-2 text-sm"
      >
        Export .pmwif
      </button>
    </div>

    <button
      type="button"
      onClick={onPreview}
      className="wallet-btn-secondary w-full py-2 font-semibold"
    >
      Preview multisig addresses
    </button>

    {error && (
      <p role="alert" className="text-xs text-red-400">
        {error}
      </p>
    )}

    {preview && (
      <div className="space-y-2 rounded-md border border-[var(--wallet-accent)] p-3">
        <p className="text-[11px] wallet-muted">
          Receive #0 · <span className="font-mono">0/0</span>
        </p>
        <p className="break-all font-mono text-xs wallet-text-strong">
          {preview.receive}
        </p>
        <p className="text-[11px] wallet-muted">
          Change #0 · <span className="font-mono">1/0</span>
        </p>
        <p className="break-all font-mono text-xs wallet-text-strong">
          {preview.change}
        </p>
        <p className="text-[11px] leading-relaxed wallet-muted">
          Every cosigner must see this same receive address. If one of them
          sees a different one, someone has a different xPub and it is not the
          same wallet.
        </p>
        {preview.missingFingerprints > 0 && (
          <p className="text-[11px] leading-relaxed text-amber-400">
            {preview.missingFingerprints} cosigner
            {preview.missingFingerprints === 1 ? '' : 's'} without a
            fingerprint. Watching and spending still work — their device just
            will not show the coins as its own when reviewing.
          </p>
        )}
      </div>
    )}
  </div>
  );
};

export const WatchOnlyWalletPreview: FC<WatchOnlyWalletPreviewProps> = ({
  onBack,
  onCreated,
}) => {
  const [network, setNetwork] = useState(Network.MAINNET);
  const [accountXpub, setAccountXpub] = useState('');
  const [walletName, setWalletName] = useState('');
  const [preview, setPreview] = useState<WatchOnlyAccountPreview | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [mode, setMode] = useState<'standard' | 'multisig'>('standard');
  const [required, setRequired] = useState(2);
  const [cosigners, setCosigners] = useState<CosignerDraft[]>([
    { name: '', xpub: '', fingerprint: '' },
    { name: '', xpub: '', fingerprint: '' },
  ]);
  const [msPreview, setMsPreview] = useState<MultisigPreview | null>(null);
  const [scanningCosigner, setScanningCosigner] = useState<number | null>(null);

  const draftPolicy = (): MultisigPolicy => ({
    name: walletName.trim() || 'Multisig',
    m: required,
    signers: cosigners.map((cosigner, index) => ({
      name: cosigner.name.trim() || `Cosigner ${index + 1}`,
      xpub: cosigner.xpub.trim(),
      masterFingerprintHex: cosigner.fingerprint.trim()
        ? cosigner.fingerprint.trim().toLowerCase()
        : undefined,
    })),
  });

  /**
   * Jump to a common policy. Existing cosigner entries are kept — switching
   * 2-of-3 to 3-of-5 should add two blank rows, not discard xPubs already
   * pasted in.
   */
  const applyPreset = (m: number, n: number) => {
    setCosigners((previous) => {
      const next = previous.slice(0, n);
      while (next.length < n) {
        next.push({ name: '', xpub: '', fingerprint: '' });
      }
      return next;
    });
    setRequired(m);
    setMsPreview(null);
    setError('');
  };

  const patchCosigner = (index: number, patch: Partial<CosignerDraft>) => {
    setCosigners((previous) =>
      previous.map((cosigner, at) =>
        at === index ? { ...cosigner, ...patch } : cosigner
      )
    );
    setMsPreview(null);
    setError('');
  };

  const handleMultisigPreview = () => {
    try {
      const policy = draftPolicy();
      const prefix =
        network === Network.MAINNET ? 'bitcoincash' : ('bchtest' as const);
      const encode = (branch: 0 | 1) => {
        const derived = deriveMultisigAddress(policy, branch, 0);
        const encoded = lockingBytecodeToCashAddress({
          bytecode: derived.lockingBytecode,
          prefix,
        });
        if (typeof encoded === 'string' || !('address' in encoded)) {
          throw new Error('Could not encode the multisig address.');
        }
        return encoded.address;
      };
      setMsPreview({
        receive: encode(0),
        change: encode(1),
        missingFingerprints: cosignersMissingFingerprint(policy).length,
      });
      setError('');
    } catch (err) {
      setMsPreview(null);
      setError(
        err instanceof Error ? err.message : 'Could not preview this policy.'
      );
    }
  };

  const handleMultisigCreate = async () => {
    setBusy(true);
    setError('');
    try {
      const walletId = await createWatchOnlyMultisigWallet({
        name: walletName,
        policy: draftPolicy(),
        network,
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

  /** Load a cosigner set exported by Paytaca (or by OPTN). */
  const handleImportPmwif = async (file: File) => {
    setError('');
    try {
      const policy = parsePmwif(await file.text());
      setWalletName((current) => current || policy.name);
      setRequired(policy.m);
      setCosigners(
        policy.signers.map((signer) => ({
          name: signer.name,
          xpub: signer.xpub,
          fingerprint: signer.masterFingerprintHex ?? '',
        }))
      );
      setMsPreview(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not read that wallet file.'
      );
    }
  };

  /** Write the cosigner set in Paytaca's format so they can load it too. */
  const handleExportPmwif = () => {
    setError('');
    try {
      const policy = draftPolicy();
      const blob = new Blob([serializePmwif(policy)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = pmwifFilename(policy);
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not export this policy.'
      );
    }
  };

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
      // No fingerprint here on purpose. Creating a watch-only wallet is a
      // scan-the-xPub step; the fingerprint is not derivable from that QR, is
      // not needed to sign, and the send screen already asks for it once and
      // remembers it. Asking twice put an unexplained hex box in onboarding
      // for something most people will skip.
      const walletId = await createWatchOnlyWallet({
        name: walletName,
        accountXpub,
        network,
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
            <p className="text-sm font-semibold wallet-text-strong">Standard</p>
            <p className="mt-1 text-[11px] wallet-muted">Account xPub</p>
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
            <p className="text-sm font-semibold wallet-text-strong">
              Multisign
            </p>
            <p className="mt-1 text-[11px] wallet-muted">Multiple cosigners</p>
          </button>
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
        </div>

        {mode === 'multisig' && (
          <MultisigCosignerForm
            required={required}
            setRequired={(value) => {
              setRequired(value);
              setMsPreview(null);
            }}
            cosigners={cosigners}
            setCosigners={(next) => {
              setCosigners(next);
              setMsPreview(null);
            }}
            patchCosigner={patchCosigner}
            applyPreset={applyPreset}
            scanningCosigner={scanningCosigner}
            setScanningCosigner={setScanningCosigner}
            onPreview={handleMultisigPreview}
            onImport={(file) => void handleImportPmwif(file)}
            onExport={handleExportPmwif}
            preview={msPreview}
            error={error}
          />
        )}

        <div
          className={`wallet-card space-y-3 p-4 ${
            mode === 'standard' ? '' : 'hidden'
          }`}
        >
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

        {mode === 'standard' && preview && (
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
          onClick={() =>
            void (mode === 'multisig' ? handleMultisigCreate() : handleCreate())
          }
          disabled={
            busy ||
            !walletName.trim() ||
            (mode === 'multisig'
              ? !msPreview
              : !accountXpub.trim() || !preview)
          }
          className="wallet-btn-primary w-full py-2 font-semibold disabled:opacity-50"
        >
          {busy
            ? 'Saving wallet…'
            : mode === 'multisig'
              ? `Save ${required}-of-${cosigners.length} watch-only wallet`
              : 'Save watch-only wallet'}
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
