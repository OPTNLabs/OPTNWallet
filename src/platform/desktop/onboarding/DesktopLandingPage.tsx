// Desktop-only landing/wallet-picker screen — Electron Cash model:
// list existing wallets (each opened with its own password), or add a new
// one (create / import / hardware wallet, as three equal top-level choices —
// not a Settings bolt-on next to an already-imported seed).
// Replaces src/features/onboarding/LandingPage.tsx via a Vite alias
// (desktop builds only); the upstream mobile page is untouched.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useLocation, useNavigate } from 'react-router-dom';
import WalletManager from '../../../apis/WalletManager/WalletManager';
import DatabaseService from '../../../apis/DatabaseManager/DatabaseService';
import { Network, setNetwork } from '../../../state/slices/networkSlice';
import { selectCurrentNetwork } from '../../../state/selectors/networkSelectors';
import {
  getAllWebviewWindows,
  getCurrentWebviewWindow,
} from '@tauri-apps/api/webviewWindow';
import { runExclusiveWalletOpen } from '../walletOpenRegistry';
import { clearWalletFusionPolicy } from '../walletFusionPolicy';
import {
  setWalletId,
  setWalletNetwork,
  setWalletType,
  setWalletDerivationPath,
} from '../../../state/slices/walletSlice';
import { WalletType, type ExtendedWalletType } from '../../../types/wallet';
import { homeRoute } from '../../../navigation/routes';
import {
  openWalletWithPassword,
  openWatchOnlyWallet,
  openHardwareWallet,
  importWalletFile,
  isBiometricAvailable,
  hasWalletBiometric,
  unlockWalletWithBiometric,
  getBiometricLabel,
} from '../DesktopWalletManager';
import type { WalletFileV1 } from '../walletFile';
import { resolveBiometricEnrollment } from '../biometricEnrollment';
import { DesktopWalletPickerActions } from './DesktopWalletPickerActions';
import { WatchOnlyWalletPreview } from './WatchOnlyWalletPreview';
import { HardwareWalletWizard } from './HardwareWalletWizard';

interface WalletRow {
  id: number;
  wallet_name: string;
  networkType: Network;
  walletType: ExtendedWalletType;
}

type LandingNavigationState = {
  openWalletId?: unknown;
  importWalletFile?: unknown;
  importColdText?: unknown;
};

function isWalletFile(value: unknown): value is WalletFileV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.format === 'optn-wallet' &&
    record.version === 1 &&
    typeof record.name === 'string' &&
    typeof record.encryptedMnemonic === 'string' &&
    typeof record.kdfSalt === 'string'
  );
}

/**
 * Raise the window that already holds a wallet, EC's `bring_to_top()`.
 *
 * Best-effort: if that window has since closed, its claim ages out via the TTL
 * and the next attempt succeeds. Failing to focus must never block the user.
 */
/**
 * Is a window with this label still open?
 *
 * Closing a window cannot be relied on to release its claim: the X button runs
 * no handler we control, and a crash runs none at all. Without this check a
 * wallet stayed "already open" in a window the user had just closed.
 */
async function isWalletWindowOpen(label: string): Promise<boolean> {
  const windows = await getAllWebviewWindows();
  return windows.some((candidate) => candidate.label === label);
}

async function focusWalletWindow(label: string): Promise<void> {
  try {
    const windows = await getAllWebviewWindows();
    const target = windows.find((candidate) => candidate.label === label);
    if (!target) return;
    await target.unminimize().catch(() => undefined);
    await target.setFocus();
  } catch {
    /* focusing is a courtesy, not a precondition */
  }
}

const DesktopLandingPage = () => {
  const [wallets, setWallets] = useState<WalletRow[] | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'list' | 'hardware' | 'watch-only'>('list');
  const [importFile, setImportFile] = useState<WalletFileV1 | null>(null);
  /** Optional encrypted .optn-cold companion from multi-select open. */
  const [importColdText, setImportColdText] = useState<string | null>(null);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioEnrolledId, setBioEnrolledId] = useState<number | null>(null);
  const [bioLabel, setBioLabel] = useState('Biometric unlock');
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const handledOpenRequest = useRef<string | null>(null);

  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch();
  const currentNetwork = useSelector(selectCurrentNetwork);

  useEffect(() => {
    void (async () => {
      const manager = WalletManager();
      const rows = await manager.getAllWallets();
      setWallets(rows as WalletRow[]);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const available = await isBiometricAvailable();
      setBioAvailable(available);
      if (available) setBioLabel(getBiometricLabel());
    })();
  }, []);

  const handleOpenClick = useCallback(async (id: number) => {
    // Watch-only and hardware are always password-gated (saved under a
    // password at create). One list action: Open → enter password.
    // Seed wallets also use the same password dialog.
    setOpeningId(id);
    setPassword('');
    setError('');
  }, []);

  // Availability resolves asynchronously after mount. Recheck the selected
  // wallet when either value changes so a prompt opened one tick earlier does
  // not permanently lose its already-enrolled biometric button. Ignore stale
  // completions when the user selects another wallet while hasData is pending.
  useEffect(() => {
    let cancelled = false;
    setBioEnrolledId(null);
    void resolveBiometricEnrollment(
      openingId,
      bioAvailable,
      hasWalletBiometric
    ).then((enrolledId) => {
      if (!cancelled) setBioEnrolledId(enrolledId);
    });
    return () => {
      cancelled = true;
    };
  }, [bioAvailable, openingId]);

  // File -> Open Wallet routes here with the requested id in navigation state.
  // Unlike the old setTimeout + CustomEvent handoff, this survives the picker
  // mount boundary and cannot fire before its listener exists.
  useEffect(() => {
    const requestedId = (location.state as LandingNavigationState | null)
      ?.openWalletId;
    if (
      typeof requestedId !== 'number' ||
      !Number.isInteger(requestedId) ||
      requestedId <= 0
    ) {
      return;
    }
    if (handledOpenRequest.current === location.key) return;
    handledOpenRequest.current = location.key;
    handleOpenClick(requestedId);
  }, [handleOpenClick, location.key, location.state]);

  // File -> Open Wallet Pack routes the parsed pack through navigation state.
  // Unlike a delayed CustomEvent, this survives the landing-page mount boundary
  // even when the first render takes longer than expected.
  useEffect(() => {
    const state = location.state as LandingNavigationState | null;
    if (!isWalletFile(state?.importWalletFile)) return;
    if (handledOpenRequest.current === location.key) return;
    handledOpenRequest.current = location.key;
    setImportFile(state.importWalletFile);
    setImportColdText(
      typeof state.importColdText === 'string' ? state.importColdText : null
    );
    setPassword('');
    setError('');
  }, [location.key, location.state]);

  // Delete ONE wallet (e.g. a duplicate) without replacing changes written by
  // another open wallet window. Its .optn file remains a recoverable backup.
  const handleDelete = async (id: number) => {
    setDeleteBusy(true);
    try {
      await WalletManager().deleteWallet(id);
      await DatabaseService().deleteWalletFromFile(id);
      // Wallet ids are reused, and fusion policy is keyed by id. Without this a
      // brand new wallet could inherit a deleted one's auto-fuse setting.
      clearWalletFusionPolicy(id);
      const rows = await WalletManager().getAllWallets();
      setWallets(rows as WalletRow[]);
      setDeletingId(null);
      window.dispatchEvent(new CustomEvent('optn:wallets-changed'));
    } catch (err) {
      console.error('[DesktopLandingPage] delete wallet failed:', err);
    } finally {
      setDeleteBusy(false);
    }
  };

  const finishOpen = (id: number, info: {
    networkType?: Network | null;
    walletType?: ExtendedWalletType | null;
    derivation_path?: string;
    derivation_path_source?: 'default' | 'custom';
  }) => {
    dispatch(setWalletId(id));
    dispatch(setWalletNetwork(info.networkType ?? Network.MAINNET));
    dispatch(setWalletType(info.walletType ?? WalletType.STANDARD));
    if (info.derivation_path) {
      dispatch(
        setWalletDerivationPath({
          path: info.derivation_path,
          source: info.derivation_path_source === 'custom' ? 'custom' : 'default',
        })
      );
    }
    dispatch(setNetwork(info.networkType ?? Network.MAINNET));
    navigate(homeRoute(id));
  };

  // Called by the watch-only create screen once the wallet row + addresses are
  // persisted. Opens it through the normal exclusive-open path so the freshly
  // created wallet lands in a window with a valid session marker.
  const handleWatchOnlyCreated = async (walletId: number) => {
    setBusy(true);
    setError('');
    try {
      const attempt = await runExclusiveWalletOpen(
        walletId,
        getCurrentWebviewWindow().label,
        () => openWatchOnlyWallet(walletId),
        isWalletWindowOpen
      );
      const rows = await WalletManager().getAllWallets();
      setWallets(rows as WalletRow[]);
      if (attempt.status === 'held') {
        await focusWalletWindow(attempt.windowLabel);
        setView('list');
        return;
      }
      if (attempt.status === 'rejected' || !attempt.value) {
        setView('list');
        return;
      }
      finishOpen(walletId, attempt.value);
    } catch (err) {
      console.error('[DesktopLandingPage] Open created watch-only wallet failed:', err);
      setError('Wallet created, but could not open it.');
      setView('list');
    } finally {
      setBusy(false);
    }
  };

  const handleBiometricUnlock = async (id: number) => {
    setBusy(true);
    setError('');
    try {
      const attempt = await runExclusiveWalletOpen(
        id,
        getCurrentWebviewWindow().label,
        () => unlockWalletWithBiometric(id),
        isWalletWindowOpen
      );
      if (attempt.status === 'held') {
        await focusWalletWindow(attempt.windowLabel);
        setError('That wallet is already open in another window.');
        return;
      }
      if (attempt.status === 'rejected') {
        setError('Biometric unlock was not accepted.');
        return;
      }
      finishOpen(id, attempt.value);
    } catch (err) {
      console.error('[DesktopLandingPage] Biometric unlock failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Biometric unlock failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  // File → Open Wallet ▸ <wallet> in the menu bar dispatches this; open that
  // wallet's password prompt (scrolling it into view via focus).
  useEffect(() => {
    const onMenuOpen = (e: Event) => {
      const id = (e as CustomEvent<{ id: number }>).detail?.id;
      if (typeof id === 'number') handleOpenClick(id);
    };
    window.addEventListener('optn:open-wallet', onMenuOpen);
    return () => window.removeEventListener('optn:open-wallet', onMenuOpen);
  }, [handleOpenClick]);

  // File → Open Wallet Pack…: .optn keystore and optional .optn-cold data.
  useEffect(() => {
    const onImportFile = (e: Event) => {
      const detail = (
        e as CustomEvent<{ file: WalletFileV1; coldArchiveText?: string | null }>
      ).detail;
      const file = detail?.file;
      if (file) {
        setImportFile(file);
        setImportColdText(
          typeof detail.coldArchiveText === 'string' ? detail.coldArchiveText : null
        );
        setPassword('');
        setError('');
      }
    };
    window.addEventListener('optn:import-wallet-file', onImportFile);
    return () => window.removeEventListener('optn:import-wallet-file', onImportFile);
  }, []);

  const handleImportSubmit = async () => {
    if (!importFile) return;
    setBusy(true);
    setError('');
    try {
      // Network priority: .optn network → .optn-cold network → app current.
      // Never hardcode mainnet (that created chipnet wallet 5 again as mainnet).
      let preferredNetwork = currentNetwork;
      const { networkFromWalletFile } = await import('../walletFile');
      const fileNet = networkFromWalletFile(importFile);
      if (fileNet === 'chipnet') preferredNetwork = Network.CHIPNET;
      else if (fileNet === 'mainnet') preferredNetwork = Network.MAINNET;
      else if (importColdText) {
        try {
          const {
            parseEncryptedColdArchive,
            decryptColdArchive,
          } = await import('../WalletColdExportService');
          const enc = parseEncryptedColdArchive(importColdText);
          const archive = await decryptColdArchive(enc, password);
          if (archive.network === 'chipnet') preferredNetwork = Network.CHIPNET;
          else if (archive.network === 'mainnet') {
            preferredNetwork = Network.MAINNET;
          }
        } catch {
          /* cold optional for network peek; import may still succeed later */
        }
      }

      const result = await importWalletFile(
        importFile,
        password,
        preferredNetwork
      );
      if (!result) {
        setError('Incorrect password for this wallet file.');
        return;
      }
      if (importColdText) {
        try {
          const { importColdDataIntoOpenWallet } = await import(
            '../WalletPackService'
          );
          await importColdDataIntoOpenWallet(
            result.walletId,
            importColdText,
            password
          );
        } catch (coldErr) {
          console.error(
            '[DesktopLandingPage] Cold data import after keystore failed:',
            coldErr
          );
          // Keys still imported — surface soft warning.
          setError(
            coldErr instanceof Error
              ? `Wallet keys imported, but data file failed: ${coldErr.message}`
              : 'Wallet keys imported, but data file failed.'
          );
        }
      }
      dispatch(setWalletId(result.walletId));
      dispatch(setWalletNetwork(result.network));
      dispatch(setWalletType(result.walletType));
      if (result.derivationPath) {
        dispatch(
          setWalletDerivationPath({
            path: result.derivationPath,
            source: result.derivationPathSource === 'custom' ? 'custom' : 'default',
          })
        );
      }
      dispatch(setNetwork(result.network));
      window.dispatchEvent(new CustomEvent('optn:wallets-changed'));
      setImportFile(null);
      setImportColdText(null);
      navigate(homeRoute(result.walletId));
    } catch (err) {
      console.error('[DesktopLandingPage] Import wallet file failed:', err);
      setError('Could not import this wallet file.');
    } finally {
      setBusy(false);
    }
  };

  const handleUnlock = async () => {
    if (openingId == null) return;
    setBusy(true);
    setError('');
    try {
      const row = wallets?.find((w) => w.id === openingId);
      // Electron Cash's single-window rule: a wallet already open elsewhere is
      // raised, not loaded a second time. Checked BEFORE the password is used,
      // so a duplicate open never derives a key or touches wallet state.
      const attempt = await runExclusiveWalletOpen(
        openingId,
        getCurrentWebviewWindow().label,
        () => {
          if (row?.walletType === 'watch-only') {
            return openWatchOnlyWallet(openingId, password);
          }
          if (row?.walletType === 'hardware') {
            return openHardwareWallet(openingId, password);
          }
          return openWalletWithPassword(openingId, password);
        },
        isWalletWindowOpen
      );
      if (attempt.status === 'held') {
        await focusWalletWindow(attempt.windowLabel);
        setError('That wallet is already open in another window.');
        return;
      }
      if (attempt.status === 'rejected') {
        setError('Incorrect password.');
        return;
      }
      finishOpen(openingId, attempt.value);
    } catch (err) {
      console.error('[DesktopLandingPage] Open wallet failed:', err);
      setError('Could not open this wallet. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleHardwareOpened = async (result: {
    walletId: number;
    created: boolean;
    name: string;
    network: Network;
    accountPath: string;
  }) => {
    setBusy(true);
    setError('');
    try {
      // Just-created wallets already have credentials cached from protect*.
      // Existing wallets need the list password dialog — if open fails free, ask.
      const attempt = await runExclusiveWalletOpen(
        result.walletId,
        getCurrentWebviewWindow().label,
        () => openHardwareWallet(result.walletId),
        isWalletWindowOpen
      );
      if (attempt.status === 'held') {
        await focusWalletWindow(attempt.windowLabel);
        setError('That wallet is already open in another window.');
        setView('list');
        return;
      }
      if (attempt.status === 'rejected' || !attempt.value) {
        // Existing passworded wallet: send user to type password on the list.
        setOpeningId(result.walletId);
        setPassword('');
        setError('Enter the password for this hardware wallet.');
        setView('list');
        return;
      }
      // Refresh list so a newly created HW wallet shows next time.
      const rows = await WalletManager().getAllWallets();
      setWallets(rows as WalletRow[]);
      window.dispatchEvent(new CustomEvent('optn:wallets-changed'));
      finishOpen(result.walletId, attempt.value);
    } catch (err) {
      console.error('[DesktopLandingPage] hardware open failed:', err);
      setError(
        err instanceof Error ? err.message : 'Could not open hardware wallet.'
      );
      setView('list');
    } finally {
      setBusy(false);
    }
  };

  if (view === 'hardware') {
    return (
      <HardwareWalletWizard
        onBack={() => {
          setError('');
          setView('list');
        }}
        onOpened={(result) => void handleHardwareOpened(result)}
      />
    );
  }

  if (view === 'watch-only') {
    return (
      <WatchOnlyWalletPreview
        onBack={() => setView('list')}
        onCreated={(walletId) => void handleWatchOnlyCreated(walletId)}
      />
    );
  }

  return (
    <section className="min-h-[100dvh] wallet-surface flex flex-col items-center px-4 py-10">
      {importFile && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="wallet-card w-full max-w-xs mx-4 p-6 space-y-4">
            <div className="text-center space-y-1">
              <div className="text-2xl">📂</div>
              <h3 className="font-bold text-lg wallet-text-strong">Open “{importFile.name}”</h3>
              <p className="text-sm wallet-muted">
                Enter this wallet file's password
                {importFile.network
                  ? ` · ${importFile.network === 'chipnet' ? 'Chipnet' : 'Mainnet'}`
                  : ''}
                . If this wallet is already saved, it will be opened — not duplicated.
              </p>
            </div>
            <input
              type="password"
              value={password}
              autoFocus
              onChange={(e) => { setPassword(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleImportSubmit(); }}
              placeholder="Password"
              className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong text-center"
            />
            {error && <p className="text-center text-xs text-red-400">{error}</p>}
            <div className="flex gap-3">
              <button
                type="button"
                className="flex-1 wallet-btn-secondary py-2"
                onClick={() => { setImportFile(null); setError(''); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="flex-1 wallet-btn-primary py-2 font-semibold"
                onClick={() => void handleImportSubmit()}
                disabled={busy}
              >
                {busy ? 'Opening…' : 'Open'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="w-full max-w-md space-y-6">
        <h1 className="text-xl font-bold wallet-text-strong text-center">OPTN Wallet</h1>

        {wallets && wallets.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm wallet-muted">Your wallets</p>
            {wallets.map((w) => (
              <div key={w.id} className="wallet-card p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold wallet-text-strong">{w.wallet_name || 'Unnamed wallet'}</p>
                    <p className="text-[10px] wallet-muted">
                      #{w.id}
                      {' · '}
                      {w.networkType === Network.CHIPNET ? 'Chipnet' : 'Mainnet'}
                      {w.walletType === 'watch-only' && (
                        <span className="ml-1.5 rounded border border-[var(--wallet-border)] px-1 py-px text-[9px] uppercase tracking-wide">
                          Watch-only
                        </span>
                      )}
                      {w.walletType === 'hardware' && (
                        <span className="ml-1.5 rounded border border-[var(--wallet-border)] px-1 py-px text-[9px] uppercase tracking-wide">
                          Hardware
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleOpenClick(w.id)}
                      className="wallet-btn-secondary px-4 py-1.5 text-sm"
                    >
                      Open
                    </button>
                    <button
                      onClick={() => { setDeletingId(deletingId === w.id ? null : w.id); setOpeningId(null); }}
                      className="text-xs text-red-400/60 hover:text-red-400 px-1.5 py-1"
                      title="Delete this wallet"
                      aria-label={`Delete ${w.wallet_name || 'unnamed wallet'}`}
                    >
                      🗑
                    </button>
                  </div>
                </div>

                {deletingId === w.id && (
                  <div className="mt-2 rounded-lg border border-red-400/30 bg-red-400/5 p-2.5 text-xs space-y-2">
                    <p className="wallet-text-strong">
                      Delete “{w.wallet_name || 'Unnamed wallet'}” ({w.networkType === Network.CHIPNET ? 'Chipnet' : 'Mainnet'})?
                      Its saved <span className="font-mono">.optn</span> file is kept, so you can re-import it later.
                    </p>
                    <div className="flex gap-2">
                      <button onClick={() => setDeletingId(null)} className="flex-1 wallet-btn-secondary py-1.5">
                        Cancel
                      </button>
                      <button
                        onClick={() => void handleDelete(w.id)}
                        disabled={deleteBusy}
                        className="flex-1 py-1.5 rounded-md bg-red-500/80 text-white font-semibold disabled:opacity-50"
                      >
                        {deleteBusy ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                )}

                {openingId === w.id && (
                  <div className="mt-3 space-y-2 border-t border-[var(--wallet-border)] pt-3">
                    <input
                      type="password"
                      value={password}
                      autoFocus
                      onChange={(e) => { setPassword(e.target.value); setError(''); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleUnlock(); }}
                      placeholder="Password"
                      className="wallet-input w-full px-3 py-2 rounded-md wallet-text-strong"
                    />
                    {error && <p className="text-xs text-red-400">{error}</p>}
                    <button
                      onClick={() => void handleUnlock()}
                      disabled={busy}
                      className="wallet-btn-primary w-full py-2 text-sm font-semibold"
                    >
                      {busy ? 'Unlocking…' : 'Unlock'}
                    </button>
                    {bioEnrolledId === w.id && w.walletType !== 'watch-only' && w.walletType !== 'hardware' && (
                      <button
                        onClick={() => void handleBiometricUnlock(w.id)}
                        disabled={busy}
                        className="wallet-btn-secondary w-full py-2 text-sm font-semibold"
                      >
                        Use {bioLabel}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <DesktopWalletPickerActions
          hasWallets={Boolean(wallets && wallets.length > 0)}
          onHardware={() => setView('hardware')}
          onWatchOnly={() => setView('watch-only')}
        />
      </div>
    </section>
  );
};

export default DesktopLandingPage;
