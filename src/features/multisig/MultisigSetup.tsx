import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { lockingBytecodeToCashAddress } from '@bitauth/libauth';
import WalletManager from '../../apis/WalletManager/WalletManager';
import WalletScreen from '../../components/ui/WalletScreen';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { Network } from '../../state/slices/networkSlice';
import { selectWalletId } from '../../state/slices/walletSlice';
import { WalletType } from '../../types/wallet';
import {
  getBchAccountPath,
  normalizeBchAccountPath,
} from '../../services/HdWalletService';
import {
  createMultisigDescriptorSet,
  deriveMultisigAddress,
  parseMultisigManifest,
  type MultisigPolicy,
} from '../../services/psbt/multisigWallet';
import {
  createMultisigWallet,
  getMultisigPolicyStatus,
  loadMultisigPolicy,
} from '../../services/multisig/MultisigStorageService';
import { createQrTransport } from './QrTransport';
import { decodeMultisigXpubExport } from '../../services/multisig/MultisigQrService';
import { deriveLocalWalletCosignerMetadata } from '../../services/WalletPublicMetadataService';
import { multisigRoute } from '../../navigation/routes';
import MultisigCosignerQr from './MultisigCosignerQr';
import BottomNavBar from '../../components/BottomNavBar';
import { copyToClipboard } from '../../utils/clipboard';
import MultisigBackButton from './MultisigBackButton';

type CosignerDraft = {
  label: string;
  xpub: string;
  fingerprint: string;
};

type LocalCosignerMetadata = Awaited<
  ReturnType<typeof deriveLocalWalletCosignerMetadata>
>;

type MultisigWalletSummary = {
  walletId: number;
  name: string;
  policyId: string;
  network: Network;
  threshold: number;
  cosignerCount: number;
  accountPath: string;
  setupStatus: 'ready' | 'needs-review' | 'migrating';
};

type SetupScreen = 'list' | 'create';
type CreateStep = 1 | 2 | 3;

const emptyCosigner = (): CosignerDraft => ({
  label: '',
  xpub: '',
  fingerprint: '',
});

/** Shared descriptor-first setup used by desktop, web, Android, and iOS. */
export default function MultisigSetup() {
  const activeNetwork = useSelector(selectCurrentNetwork);
  const activeWalletId = useSelector(selectWalletId);
  const navigate = useNavigate();
  const [name, setName] = useState('Multisig wallet');
  const [accountPath, setAccountPath] = useState(() =>
    getBchAccountPath(activeNetwork)
  );
  // Setup is a separate policy workflow. Changing its network must not
  // reconfigure the currently-open mnemonic wallet underneath the user.
  const [setupNetwork, setSetupNetwork] = useState(activeNetwork);
  const [threshold, setThreshold] = useState(2);
  const [cosigners, setCosigners] = useState<CosignerDraft[]>([
    emptyCosigner(),
    emptyCosigner(),
  ]);
  const [manifestText, setManifestText] = useState('');
  const [busy, setBusy] = useState(false);
  const [localCosignerBusy, setLocalCosignerBusy] = useState(false);
  const [localCosignerMetadata, setLocalCosignerMetadata] =
    useState<LocalCosignerMetadata | null>(null);
  const [cosignerQr, setCosignerQr] = useState<LocalCosignerMetadata | null>(
    null
  );
  const [scanningIndex, setScanningIndex] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [navBarHeight, setNavBarHeight] = useState(0);
  const [multisigWallets, setMultisigWallets] = useState<
    MultisigWalletSummary[]
  >([]);
  const [multisigWalletsBusy, setMultisigWalletsBusy] = useState(true);
  const [multisigWalletsError, setMultisigWalletsError] = useState('');
  const [screen, setScreen] = useState<SetupScreen>('list');
  const [createStep, setCreateStep] = useState<CreateStep>(1);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const stepScrollRef = useRef<HTMLDivElement>(null);

  const loadMultisigWallets = useCallback(async () => {
    setMultisigWalletsBusy(true);
    setMultisigWalletsError('');
    try {
      const wallets = await WalletManager().getAllWallets();
      const summaries = await Promise.all(
        wallets
          .filter((wallet) => wallet.walletType === WalletType.MULTISIG)
          .map(async (wallet) => {
            try {
              const [stored, policy] = await Promise.all([
                getMultisigPolicyStatus(wallet.id),
                loadMultisigPolicy(wallet.id),
              ]);
              if (!stored || !policy) return null;
              return {
                walletId: wallet.id,
                name: wallet.wallet_name?.trim() || stored.name,
                policyId: stored.policyId,
                network: stored.network,
                threshold: stored.threshold,
                cosignerCount: policy.signers.length,
                accountPath: stored.accountPath,
                setupStatus: stored.setupStatus,
              } satisfies MultisigWalletSummary;
            } catch {
              return null;
            }
          })
      );
      setMultisigWallets(
        summaries
          .filter(
            (summary): summary is MultisigWalletSummary => summary !== null
          )
          .sort((left, right) => left.walletId - right.walletId)
      );
      if (summaries.filter((summary) => summary !== null).length === 0) {
        setScreen('create');
        setCreateStep(1);
      }
    } catch (cause) {
      setMultisigWalletsError(
        cause instanceof Error
          ? cause.message
          : 'Could not load existing multisig wallets.'
      );
    } finally {
      setMultisigWalletsBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadMultisigWallets();
  }, [loadMultisigWallets]);

  useEffect(() => {
    const element = stepScrollRef.current;
    if (!element) return;
    element.scrollTop = 0;
    element.scrollTo?.({ top: 0, behavior: 'auto' });
  }, [createStep, screen]);

  const openMultisigWorkspace = (wallet: MultisigWalletSummary) => {
    // The multisig ID is route-scoped. Do not replace the standard wallet's
    // Redux session, which owns mnemonic access, normal address derivation,
    // UTXO workers, Settings, and the bottom navigation.
    navigate(multisigRoute(wallet.walletId), { replace: true });
  };

  const copyValue = async (value: string) => {
    const copied = await copyToClipboard(value);
    if (!copied) return;
    setCopiedValue(value);
    window.setTimeout(() => {
      setCopiedValue((current) => (current === value ? null : current));
    }, 1800);
  };

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--navbar-height',
      `${navBarHeight}px`
    );

    return () => {
      document.documentElement.style.setProperty('--navbar-height', '0px');
    };
  }, [navBarHeight]);

  const policy = useMemo<MultisigPolicy>(
    () => ({
      name,
      m: threshold,
      threshold,
      network: setupNetwork,
      accountPath,
      policyRevision: 0,
      signers: cosigners.map((cosigner, index) => ({
        name: cosigner.label || `Cosigner ${index + 1}`,
        label: cosigner.label || `Cosigner ${index + 1}`,
        xpub: cosigner.xpub.trim(),
        masterFingerprintHex: cosigner.fingerprint.trim() || undefined,
        accountPath,
      })),
    }),
    [accountPath, cosigners, name, setupNetwork, threshold]
  );

  const preview = useMemo(() => {
    try {
      const descriptors = createMultisigDescriptorSet(policy, setupNetwork);
      const address = deriveMultisigAddress(policy, 0, 0);
      const encoded = lockingBytecodeToCashAddress({
        bytecode: address.lockingBytecode,
        prefix: setupNetwork === 'mainnet' ? 'bitcoincash' : 'bchtest',
      });
      if (typeof encoded === 'string')
        throw new Error('Could not encode the preview address.');
      return {
        descriptors,
        address,
        previewAddress: encoded.address,
        error: '',
      };
    } catch (cause) {
      return {
        descriptors: null,
        address: null,
        previewAddress: '',
        error:
          cause instanceof Error
            ? cause.message
            : 'Complete the cosigner details to preview the policy.',
      };
    }
  }, [policy, setupNetwork]);

  const readyCosignerCount = cosigners.filter(
    (cosigner) => cosigner.xpub.trim() && cosigner.fingerprint.trim()
  ).length;
  const setupComplete =
    Boolean(preview.descriptors) && readyCosignerCount === cosigners.length;

  const patchCosigner = (index: number, patch: Partial<CosignerDraft>) => {
    setCosigners((current) =>
      current.map((cosigner, at) =>
        at === index ? { ...cosigner, ...patch } : cosigner
      )
    );
    setError('');
  };

  const importXpub = async (index: number) => {
    setScanningIndex(index);
    setError('');
    try {
      const payload = await createQrTransport().scanSingle();
      if (!payload) return;
      const imported = decodeMultisigXpubExport(payload);
      patchCosigner(index, {
        xpub: imported.xpub,
        fingerprint: imported.masterFingerprintHex ?? '',
      });
      if (imported.accountPath) setAccountPath(imported.accountPath);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not import the cosigner xpub.'
      );
    } finally {
      setScanningIndex(null);
    }
  };

  const handleUseActiveWallet = async () => {
    if (!activeWalletId || activeWalletId <= 0) {
      setError('Open and unlock an OPTN wallet before using it as a cosigner.');
      return;
    }
    if (localCosignerBusy) return;
    setLocalCosignerBusy(true);
    setError('');
    try {
      const metadata = await deriveLocalWalletCosignerMetadata(activeWalletId);
      if (metadata.network !== setupNetwork) {
        throw new Error(
          `The active wallet is on ${metadata.network}; switch the multisig setup to that network first.`
        );
      }
      setLocalCosignerMetadata(metadata);
      const target = cosigners.findIndex((cosigner) => !cosigner.xpub.trim());
      const targetIndex = target >= 0 ? target : 0;
      patchCosigner(targetIndex, {
        label: 'This device',
        xpub: metadata.accountXpub,
        fingerprint: metadata.masterFingerprintHex,
      });
      setAccountPath(metadata.accountPath);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not derive the active wallet fingerprint and xpub.'
      );
    } finally {
      setLocalCosignerBusy(false);
    }
  };

  const showActiveWalletQr = async () => {
    if (!activeWalletId || activeWalletId <= 0) {
      setError(
        'Open and unlock an OPTN wallet before showing its cosigner QR.'
      );
      return;
    }
    if (localCosignerBusy) return;
    setLocalCosignerBusy(true);
    setError('');
    try {
      const metadata = await deriveLocalWalletCosignerMetadata(activeWalletId);
      if (metadata.network !== setupNetwork) {
        throw new Error(
          `The active wallet is on ${metadata.network}; switch the setup to that network first.`
        );
      }
      setLocalCosignerMetadata(metadata);
      setCosignerQr(metadata);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not prepare the cosigner QR.'
      );
    } finally {
      setLocalCosignerBusy(false);
    }
  };

  const importManifest = () => {
    setError('');
    try {
      const imported = parseMultisigManifest(manifestText, setupNetwork);
      setName(imported.name);
      if (imported.network) setSetupNetwork(imported.network);
      setAccountPath(
        imported.accountPath ??
          getBchAccountPath(imported.network ?? setupNetwork)
      );
      setThreshold(imported.m);
      setCosigners(
        imported.signers.map((signer) => ({
          label: signer.label ?? signer.name,
          xpub: signer.xpub,
          fingerprint: signer.masterFingerprintHex ?? '',
        }))
      );
      setCreateStep(3);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not import the multisig manifest.'
      );
    }
  };

  const continueToCosigners = () => {
    setError('');
    if (!name.trim()) {
      setError('Give the shared wallet a name before continuing.');
      return;
    }
    try {
      setAccountPath(normalizeBchAccountPath(accountPath));
      setCreateStep(2);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Enter a valid BCH account path before continuing.'
      );
    }
  };

  const continueToReview = () => {
    setError('');
    if (threshold < 1 || threshold > cosigners.length) {
      setError(
        `Required signatures must be between 1 and ${cosigners.length}.`
      );
      return;
    }
    const incompleteIndex = cosigners.findIndex(
      (cosigner) => !cosigner.xpub.trim() || !cosigner.fingerprint.trim()
    );
    if (incompleteIndex >= 0) {
      setError(
        `Finish Cosigner ${incompleteIndex + 1}: add its account xpub and 8-character master fingerprint.`
      );
      return;
    }
    try {
      setAccountPath(normalizeBchAccountPath(accountPath));
      setCreateStep(3);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Enter a valid BCH account path before continuing.'
      );
    }
  };

  const returnToMultisigList = () => {
    setError('');
    setCreateStep(1);
    setScreen('list');
  };

  const cancelSetup = () => {
    if (multisigWallets.length > 0) {
      returnToMultisigList();
      return;
    }
    navigate(-1);
  };

  const goToPreviousCreateStep = () => {
    setError('');
    setCreateStep((current) =>
      current === 1 ? 1 : ((current - 1) as CreateStep)
    );
  };

  const create = async () => {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const normalizedPath = normalizeBchAccountPath(accountPath);
      const walletId = await createMultisigWallet({
        name,
        policy: { ...policy, accountPath: normalizedPath },
        network: setupNetwork,
      });
      const persisted = await getMultisigPolicyStatus(walletId);
      if (!persisted || persisted.policyId !== preview.descriptors?.policyId) {
        throw new Error(
          'The multisig policy was not persisted correctly; the wallet was not opened.'
        );
      }
      const createdWallet: MultisigWalletSummary = {
        walletId,
        name: name.trim(),
        policyId: persisted.policyId,
        network: setupNetwork,
        threshold: persisted.threshold,
        cosignerCount: policy.signers.length,
        accountPath: normalizedPath,
        setupStatus: persisted.setupStatus,
      };
      setMultisigWallets((current) =>
        [
          ...current.filter((wallet) => wallet.walletId !== walletId),
          createdWallet,
        ].sort((left, right) => left.walletId - right.walletId)
      );
      window.dispatchEvent(new CustomEvent('optn:wallets-changed'));
      // Creating a policy is never a wallet switch. Open only the route-scoped
      // workspace; the standard mnemonic wallet remains the default session.
      navigate(multisigRoute(walletId), { replace: true });
      setError('');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not create the multisig wallet.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--wallet-bg)]">
      <main className="min-h-0 flex-1 overflow-hidden">
        <WalletScreen
          maxWidthClassName="max-w-3xl"
          scrollable={false}
          reserveBottomNavSpace
        >
          <div className="flex h-full min-h-0 flex-col gap-3">
            <MultisigBackButton
              className="self-start"
              onClick={() => {
                setError('');
                if (screen === 'create') {
                  setCreateStep(1);
                  setScreen('list');
                  return;
                }
                navigate(-1);
              }}
            />
            <div
              ref={stepScrollRef}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"
            >
              <div className="mx-auto flex w-full flex-col gap-4 pb-4">
                {screen === 'list' ? (
                  <section className="wallet-card space-y-4 p-4">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--wallet-accent-strong)]">
                        Shared wallets
                      </p>
                      <h1 className="mt-1 text-xl font-bold wallet-text-strong">
                        Multisig wallets
                      </h1>
                      <p className="mt-1 text-sm wallet-muted">
                        Your shared policies live separately from your default
                        mnemonic wallet. Choose a policy to open it, or create a
                        new one with the other cosigners.
                      </p>
                    </div>
                    {multisigWalletsBusy ? (
                      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3">
                        <p className="text-sm wallet-muted">
                          Loading your multisig wallets…
                        </p>
                      </div>
                    ) : multisigWallets.length > 0 ? (
                      <div className="space-y-3 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3">
                        <div>
                          <h2 className="text-sm font-semibold wallet-text-strong">
                            Your multisig wallets
                          </h2>
                          <p className="mt-1 text-xs wallet-muted">
                            Opening one does not replace your standard wallet or
                            its recovery phrase.
                          </p>
                        </div>
                        {multisigWallets.map((wallet) => (
                          <div
                            key={wallet.walletId}
                            className="space-y-3 rounded-xl border border-[var(--wallet-border)] p-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold wallet-text-strong">
                                  {wallet.name}
                                </p>
                                <p className="mt-1 text-xs wallet-muted">
                                  {wallet.threshold} of {wallet.cosignerCount}{' '}
                                  signatures · {wallet.network}
                                </p>
                              </div>
                              <span className="shrink-0 rounded-full border border-emerald-500/40 px-2 py-1 text-[10px] uppercase tracking-wide text-emerald-300">
                                {wallet.setupStatus === 'ready'
                                  ? 'Ready'
                                  : wallet.setupStatus}
                              </span>
                            </div>
                            <div className="rounded-lg border border-[var(--wallet-border)] p-2">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-[10px] font-semibold uppercase tracking-wide wallet-muted">
                                  Policy ID
                                </p>
                                <button
                                  type="button"
                                  className="text-[10px] font-semibold text-[var(--wallet-accent-strong)]"
                                  onClick={() =>
                                    void copyValue(wallet.policyId)
                                  }
                                >
                                  {copiedValue === wallet.policyId
                                    ? 'Copied'
                                    : 'Copy'}
                                </button>
                              </div>
                              <p className="mt-1 break-all font-mono text-[10px] wallet-muted">
                                {wallet.policyId}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="wallet-btn-primary w-full py-3 text-sm"
                              onClick={() => openMultisigWorkspace(wallet)}
                              disabled={wallet.setupStatus !== 'ready'}
                            >
                              {wallet.setupStatus === 'ready'
                                ? 'Open multisig workspace'
                                : 'Policy needs review'}
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-[var(--wallet-border)] p-4">
                        <p className="text-sm font-semibold wallet-text-strong">
                          No multisig wallets yet
                        </p>
                        <p className="mt-1 text-xs leading-relaxed wallet-muted">
                          Your normal single-key wallet is still your default. A
                          shared wallet will appear here after you create it.
                        </p>
                      </div>
                    )}
                    {multisigWalletsError && (
                      <p role="alert" className="text-xs text-red-400">
                        {multisigWalletsError}
                      </p>
                    )}
                    <button
                      type="button"
                      className="wallet-btn-primary w-full py-3 text-sm"
                      onClick={() => {
                        setError('');
                        setCreateStep(1);
                        setScreen('create');
                      }}
                    >
                      Create a new multisig wallet
                    </button>
                  </section>
                ) : (
                  <>
                    <section className="wallet-card space-y-4 p-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--wallet-accent-strong)]">
                          New shared wallet
                        </p>
                        <h1 className="mt-1 text-xl font-bold wallet-text-strong">
                          Create a multisig wallet
                        </h1>
                        <p className="mt-1 text-sm leading-relaxed wallet-muted">
                          Complete one step at a time with the other cosigners.
                          Your normal recovery phrase stays unchanged.
                        </p>
                      </div>
                      <ol className="grid grid-cols-3 gap-2 text-center text-[10px] font-semibold">
                        {[
                          ['1', 'Wallet'],
                          ['2', 'Cosigners'],
                          ['3', 'Review'],
                        ].map(([number, label], index) => {
                          const step = (index + 1) as CreateStep;
                          const done = step < createStep;
                          const active = step === createStep;
                          return (
                            <li
                              key={number}
                              className={`rounded-lg border px-2 py-2 ${
                                active
                                  ? 'border-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10 text-[var(--wallet-accent-strong)]'
                                  : done
                                    ? 'border-emerald-500/40 text-emerald-300'
                                    : 'border-[var(--wallet-border)] wallet-muted'
                              }`}
                            >
                              <span className="block text-xs">
                                {done ? '✓' : number}
                              </span>
                              {label}
                            </li>
                          );
                        })}
                      </ol>
                      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold wallet-text-strong">
                            Cosigner identities
                          </p>
                          <span className="rounded-full border border-[var(--wallet-border)] px-2 py-1 text-[10px] font-semibold wallet-muted">
                            {readyCosignerCount} of {cosigners.length} ready
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed wallet-muted">
                          We will guide you through the wallet details, each
                          cosigner identity, and the final shared policy review.
                        </p>
                      </div>
                    </section>
                    {error && (
                      <p role="alert" className="text-sm text-red-400">
                        {error}
                      </p>
                    )}
                    {createStep === 1 && (
                      <>
                        <section className="wallet-card space-y-4 p-4">
                          <div>
                            <h2 className="text-base font-bold wallet-text-strong">
                              Step 1 · Choose the shared wallet
                            </h2>
                            <p className="mt-1 text-xs wallet-muted">
                              These settings must match on every cosigner
                              device.
                            </p>
                          </div>
                          <div className="space-y-3 rounded-xl border border-[var(--wallet-border)] p-3">
                            <div>
                              <p className="text-sm font-semibold wallet-text-strong">
                                Import an existing policy (optional)
                              </p>
                              <p className="mt-1 text-xs wallet-muted">
                                If another device already created the wallet,
                                paste its complete manifest here and review the
                                shared policy.
                              </p>
                            </div>
                            <textarea
                              className="wallet-input min-h-24 w-full resize-y font-mono text-[10px]"
                              value={manifestText}
                              onChange={(event) =>
                                setManifestText(event.target.value)
                              }
                              placeholder="Paste the complete OPTN policy manifest"
                            />
                            <button
                              type="button"
                              className="wallet-btn-secondary w-full"
                              onClick={importManifest}
                              disabled={!manifestText.trim()}
                            >
                              Import and review policy
                            </button>
                          </div>
                          <div className="rounded-xl border border-[var(--wallet-border)] p-3">
                            <p className="text-sm font-semibold wallet-text-strong">
                              Share this device&apos;s identity
                            </p>
                            <p className="mt-1 text-xs wallet-muted">
                              This uses public wallet information only. Your
                              recovery phrase never leaves this device.
                            </p>
                            <button
                              type="button"
                              className="wallet-btn-secondary mt-2 w-full"
                              onClick={() => void handleUseActiveWallet()}
                              disabled={localCosignerBusy}
                            >
                              {localCosignerBusy
                                ? 'Deriving public identity…'
                                : 'Add this device as a cosigner'}
                            </button>
                            <button
                              type="button"
                              className="wallet-btn-secondary mt-2 w-full"
                              onClick={() => void showActiveWalletQr()}
                              disabled={localCosignerBusy}
                            >
                              {localCosignerBusy
                                ? 'Preparing cosigner QR…'
                                : 'Show QR for another device to scan'}
                            </button>
                            {localCosignerMetadata && (
                              <div className="mt-3 space-y-1 rounded-lg border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3 text-xs">
                                <p className="font-semibold wallet-text-strong">
                                  Active wallet identity
                                </p>
                                <p className="wallet-muted">
                                  Master fingerprint:{' '}
                                  <span className="font-mono font-semibold wallet-text-strong">
                                    {localCosignerMetadata.masterFingerprintHex.toUpperCase()}
                                  </span>
                                </p>
                                <p className="wallet-muted">
                                  Account path:{' '}
                                  {localCosignerMetadata.accountPath}
                                </p>
                              </div>
                            )}
                          </div>
                          <label className="block text-sm wallet-text-strong">
                            Shared wallet name
                            <input
                              className="wallet-input mt-1 w-full"
                              value={name}
                              onChange={(event) => setName(event.target.value)}
                            />
                          </label>
                          <div className="grid gap-3 sm:grid-cols-3">
                            <label className="block text-sm wallet-text-strong">
                              Network
                              <select
                                className="wallet-input mt-1 w-full"
                                value={setupNetwork}
                                onChange={(event) =>
                                  setSetupNetwork(
                                    event.target.value as typeof setupNetwork
                                  )
                                }
                              >
                                <option value="mainnet">Mainnet</option>
                                <option value="chipnet">Chipnet</option>
                              </select>
                            </label>
                            <label className="block text-sm wallet-text-strong">
                              Required signatures (threshold)
                              <input
                                className="wallet-input mt-1 w-full"
                                type="number"
                                min={1}
                                max={cosigners.length}
                                value={threshold}
                                onChange={(event) =>
                                  setThreshold(
                                    Math.max(1, Number(event.target.value) || 1)
                                  )
                                }
                              />
                            </label>
                            <label className="block text-sm wallet-text-strong">
                              Account path
                              <input
                                className="wallet-input mt-1 w-full font-mono text-xs"
                                value={accountPath}
                                onChange={(event) =>
                                  setAccountPath(event.target.value)
                                }
                              />
                            </label>
                          </div>
                        </section>
                      </>
                    )}
                    {createStep === 2 && (
                      <section className="wallet-card space-y-4 p-4">
                        <div>
                          <h2 className="text-base font-bold wallet-text-strong">
                            Step 2 · Add the other cosigners
                          </h2>
                          <p className="mt-1 text-xs leading-relaxed wallet-muted">
                            Add each account xpub and its master fingerprint.
                            Scanning the identity QR fills both fields for you.
                          </p>
                        </div>
                        <div className="space-y-3">
                          {cosigners.map((cosigner, index) => (
                            <div
                              key={index}
                              className="rounded-xl border border-[var(--wallet-border)] p-3"
                            >
                              <div className="mb-2 flex items-start justify-between gap-2">
                                <div>
                                  <strong className="wallet-text-strong">
                                    Cosigner {index + 1}
                                  </strong>
                                  <p className="mt-1 text-[11px] wallet-muted">
                                    {cosigner.xpub.trim() &&
                                    cosigner.fingerprint.trim()
                                      ? 'Identity ready'
                                      : cosigner.xpub.trim()
                                        ? 'Fingerprint still needed'
                                        : 'Scan or enter this cosigner identity'}
                                  </p>
                                </div>
                                <span
                                  className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${
                                    cosigner.xpub.trim() &&
                                    cosigner.fingerprint.trim()
                                      ? 'border-emerald-500/40 text-emerald-300'
                                      : 'border-amber-500/40 text-amber-300'
                                  }`}
                                >
                                  {cosigner.xpub.trim() &&
                                  cosigner.fingerprint.trim()
                                    ? 'Ready'
                                    : 'Incomplete'}
                                </span>
                                {cosigners.length > 2 && (
                                  <button
                                    type="button"
                                    className="text-xs text-red-400"
                                    onClick={() => {
                                      setCosigners((current) =>
                                        current.filter((_, at) => at !== index)
                                      );
                                      setThreshold((current) =>
                                        Math.min(current, cosigners.length - 1)
                                      );
                                    }}
                                  >
                                    Remove
                                  </button>
                                )}
                              </div>
                              <div className="grid gap-2 sm:grid-cols-[1fr_2fr_1fr_auto]">
                                <input
                                  className="wallet-input"
                                  placeholder="Label"
                                  value={cosigner.label}
                                  onChange={(event) =>
                                    patchCosigner(index, {
                                      label: event.target.value,
                                    })
                                  }
                                />
                                <input
                                  className="wallet-input font-mono text-xs"
                                  placeholder="Account xpub · QR recommended"
                                  value={cosigner.xpub}
                                  onChange={(event) =>
                                    patchCosigner(index, {
                                      xpub: event.target.value,
                                    })
                                  }
                                />
                                <input
                                  className="wallet-input font-mono text-xs"
                                  placeholder="8-character fingerprint"
                                  maxLength={8}
                                  value={cosigner.fingerprint}
                                  onChange={(event) =>
                                    patchCosigner(index, {
                                      fingerprint: event.target.value,
                                    })
                                  }
                                />
                                <button
                                  type="button"
                                  className="wallet-btn-secondary whitespace-nowrap"
                                  onClick={() => void importXpub(index)}
                                  disabled={scanningIndex !== null}
                                >
                                  {scanningIndex === index
                                    ? 'Scanning…'
                                    : 'Scan identity QR'}
                                </button>
                              </div>
                              {cosigner.xpub.trim() &&
                                !cosigner.fingerprint.trim() && (
                                  <p className="mt-2 text-xs text-amber-300">
                                    Required: the 8-character master fingerprint
                                    for this xpub. A bare xpub does not contain
                                    it; read it from the signer or import a
                                    descriptor/manifest that includes key
                                    origin.
                                  </p>
                                )}
                            </div>
                          ))}
                        </div>
                        {cosigners.length < 15 && (
                          <button
                            type="button"
                            className="wallet-btn-secondary"
                            onClick={() =>
                              setCosigners((current) => [
                                ...current,
                                emptyCosigner(),
                              ])
                            }
                          >
                            Add cosigner
                          </button>
                        )}
                      </section>
                    )}
                    {createStep === 3 && (
                      <section className="wallet-card space-y-3 p-4">
                        <div>
                          <h2 className="text-base font-bold wallet-text-strong">
                            Step 3 · Review and create
                          </h2>
                          <p className="mt-1 text-xs leading-relaxed wallet-muted">
                            Compare this review with the other devices. Every
                            device should show the same policy ID before anyone
                            uses the shared wallet.
                          </p>
                        </div>
                        <div className="rounded-xl border border-[var(--wallet-accent)] bg-[var(--wallet-surface)] p-3">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-semibold wallet-text-strong">
                              Policy review
                            </p>
                            <span className="text-xs font-semibold text-[var(--wallet-accent-strong)]">
                              {setupComplete
                                ? 'Ready to create'
                                : 'Finish the highlighted fields'}
                            </span>
                          </div>
                          {preview.descriptors ? (
                            <>
                              <div className="mt-3 space-y-2 text-xs">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="wallet-muted">Network</span>
                                  <span className="font-semibold wallet-text-strong">
                                    {setupNetwork === Network.MAINNET
                                      ? 'Mainnet'
                                      : 'Chipnet'}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between gap-2">
                                  <span className="wallet-muted">
                                    Threshold
                                  </span>
                                  <span className="font-semibold wallet-text-strong">
                                    {threshold} of {cosigners.length}
                                  </span>
                                </div>
                                <div className="flex items-start justify-between gap-2">
                                  <span className="wallet-muted">
                                    Account path
                                  </span>
                                  <span className="font-mono text-right wallet-text-strong">
                                    {accountPath}
                                  </span>
                                </div>
                              </div>
                              <div className="mt-3 rounded-lg border border-[var(--wallet-border)] p-2">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-[10px] font-semibold uppercase tracking-wide wallet-muted">
                                    Policy ID
                                  </p>
                                  <button
                                    type="button"
                                    className="text-[10px] font-semibold text-[var(--wallet-accent-strong)]"
                                    onClick={() =>
                                      void copyValue(
                                        preview.descriptors!.policyId
                                      )
                                    }
                                  >
                                    {copiedValue ===
                                    preview.descriptors.policyId
                                      ? 'Copied'
                                      : 'Copy'}
                                  </button>
                                </div>
                                <p className="mt-1 break-all font-mono text-[10px] wallet-text-strong">
                                  {preview.descriptors.policyId}
                                </p>
                              </div>
                              {preview.address && (
                                <div className="mt-3 flex items-center gap-3 rounded-lg border border-[var(--wallet-border)] p-2">
                                  <QRCodeSVG
                                    value={preview.previewAddress}
                                    size={80}
                                  />
                                  <div className="min-w-0 text-xs">
                                    <div className="flex items-center justify-between gap-2">
                                      <p className="font-semibold wallet-text-strong">
                                        First receive preview
                                      </p>
                                      <button
                                        type="button"
                                        className="text-[10px] font-semibold text-[var(--wallet-accent-strong)]"
                                        onClick={() =>
                                          void copyValue(preview.previewAddress)
                                        }
                                      >
                                        {copiedValue === preview.previewAddress
                                          ? 'Copied'
                                          : 'Copy'}
                                      </button>
                                    </div>
                                    <p className="mt-1 break-all font-mono text-[10px] wallet-muted">
                                      {preview.previewAddress}
                                    </p>
                                    <p className="mt-1 wallet-muted">
                                      This is index 0. The receive screen
                                      reserves an index only when you choose to
                                      use it.
                                    </p>
                                  </div>
                                </div>
                              )}
                            </>
                          ) : (
                            <p className="text-sm wallet-muted">
                              {preview.error}
                            </p>
                          )}
                          <p className="text-xs wallet-muted">
                            This v1 policy uses P2SH20 with OP_CHECKMULTISIG.
                            Cosigner membership and threshold replacement are
                            not available from this screen.
                          </p>
                        </div>
                      </section>
                    )}
                  </>
                )}
              </div>
            </div>
            {screen === 'create' && (
              <div className="shrink-0 space-y-2 border-t border-[var(--wallet-border)] pt-3">
                {createStep < 3 ? (
                  <div className="flex gap-2">
                    {createStep > 1 && (
                      <button
                        type="button"
                        className="wallet-btn-secondary flex-1"
                        onClick={goToPreviousCreateStep}
                      >
                        Previous step
                      </button>
                    )}
                    <button
                      type="button"
                      className="wallet-btn-primary flex-1"
                      onClick={
                        createStep === 1
                          ? continueToCosigners
                          : continueToReview
                      }
                    >
                      {createStep === 1
                        ? 'Continue to cosigners'
                        : 'Continue to review'}
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="wallet-btn-primary w-full"
                      onClick={() => void create()}
                      disabled={busy || !setupComplete}
                    >
                      {busy ? 'Creating…' : 'Approve and create shared wallet'}
                    </button>
                    <button
                      type="button"
                      className="wallet-btn-danger w-full"
                      onClick={cancelSetup}
                    >
                      Cancel setup
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {cosignerQr && (
            <MultisigCosignerQr
              payload={{
                xpub: cosignerQr.accountXpub,
                masterFingerprintHex: cosignerQr.masterFingerprintHex,
                accountPath: cosignerQr.accountPath,
              }}
              onClose={() => setCosignerQr(null)}
            />
          )}
        </WalletScreen>
      </main>
      <BottomNavBar setNavBarHeight={setNavBarHeight} />
    </div>
  );
}
