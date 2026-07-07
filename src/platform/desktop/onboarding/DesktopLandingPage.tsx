// Desktop-only landing/wallet-picker screen — Electron Cash model:
// list existing wallets (each opened with its own password), or add a new
// one (create / import / hardware wallet, as three equal top-level choices —
// not a Settings bolt-on next to an already-imported seed).
// Replaces src/features/onboarding/LandingPage.tsx via a Vite alias
// (desktop builds only); the upstream mobile page is untouched.
import { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Link, useNavigate } from 'react-router-dom';
import WalletManager from '../../../apis/WalletManager/WalletManager';
import { Network } from '../../../state/slices/networkSlice';
import { setNetwork } from '../../../state/slices/networkSlice';
import { setWalletId, setWalletNetwork, setWalletType } from '../../../state/slices/walletSlice';
import { WalletType } from '../../../types/wallet';
import { homeRoute } from '../../../navigation/routes';
import {
  openWalletWithPassword,
  importWalletFile,
  isBiometricAvailable,
  hasWalletBiometric,
  unlockWalletWithBiometric,
  getBiometricLabel,
} from '../DesktopWalletManager';
import type { WalletFileV1 } from '../walletFile';
import { selectHardwareWallet } from '../../../state/slices/hardwareWalletSlice';
import { HardwareWalletSettings } from '../../../features/settings/HardwareWalletSettings';

interface WalletRow {
  id: number;
  wallet_name: string;
  networkType: Network;
  walletType: WalletType;
}

const DesktopLandingPage = () => {
  const [wallets, setWallets] = useState<WalletRow[] | null>(null);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'list' | 'hardware'>('list');
  const [importFile, setImportFile] = useState<WalletFileV1 | null>(null);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioEnrolledId, setBioEnrolledId] = useState<number | null>(null);
  const [bioLabel, setBioLabel] = useState('Biometric unlock');

  const navigate = useNavigate();
  const dispatch = useDispatch();
  const hw = useSelector(selectHardwareWallet);

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

  const handleOpenClick = useCallback((id: number) => {
    setOpeningId(id);
    setPassword('');
    setError('');
    setBioEnrolledId(null);
    // Show the biometric button only if THIS wallet has an enrollment.
    if (bioAvailable) {
      void hasWalletBiometric(id).then((enrolled) => {
        if (enrolled) setBioEnrolledId(id);
      });
    }
  }, [bioAvailable]);

  const finishOpen = (id: number, info: { networkType?: Network | null; walletType?: WalletType | null }) => {
    dispatch(setWalletId(id));
    dispatch(setWalletNetwork(info.networkType ?? Network.MAINNET));
    dispatch(setWalletType(info.walletType ?? WalletType.STANDARD));
    dispatch(setNetwork(info.networkType ?? Network.MAINNET));
    navigate(homeRoute(id));
  };

  const handleBiometricUnlock = async (id: number) => {
    setBusy(true);
    setError('');
    try {
      const info = await unlockWalletWithBiometric(id);
      if (!info) {
        setError('Biometric unlock was cancelled or failed.');
        return;
      }
      finishOpen(id, info);
    } catch (err) {
      console.error('[DesktopLandingPage] Biometric unlock failed:', err);
      setError('Biometric unlock failed.');
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

  // File → Open Wallet ▸ Open Wallet File… picked a .optn on disk; ask for its
  // password and import it into this app (a new DB row + its own auto-saved file).
  useEffect(() => {
    const onImportFile = (e: Event) => {
      const file = (e as CustomEvent<{ file: WalletFileV1 }>).detail?.file;
      if (file) {
        setImportFile(file);
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
      const result = await importWalletFile(importFile, password, Network.MAINNET);
      if (!result) {
        setError('Incorrect password for this wallet file.');
        return;
      }
      dispatch(setWalletId(result.walletId));
      dispatch(setWalletNetwork(result.network));
      dispatch(setWalletType(result.walletType));
      dispatch(setNetwork(result.network));
      window.dispatchEvent(new CustomEvent('optn:wallets-changed'));
      setImportFile(null);
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
      const info = await openWalletWithPassword(openingId, password);
      if (!info) {
        setError('Incorrect password.');
        return;
      }
      finishOpen(openingId, info);
    } catch (err) {
      console.error('[DesktopLandingPage] Open wallet failed:', err);
      setError('Could not open this wallet. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (view === 'hardware') {
    return (
      <section className="min-h-[100dvh] wallet-surface flex flex-col items-center px-4 py-10">
        <div className="w-full max-w-md space-y-4">
          <h1 className="text-xl font-bold wallet-text-strong text-center">Connect Hardware Wallet</h1>
          <HardwareWalletSettings />
          {hw.connected && (
            <div className="wallet-card p-3 space-y-2">
              <p className="text-sm wallet-text-strong">
                {hw.deviceLabel ?? 'Device'} connected. It will be used automatically to sign
                sends from software wallets while connected. Standalone hardware-only wallets
                with their own receive addresses aren't supported yet.
              </p>
            </div>
          )}
          <button onClick={() => setView('list')} className="wallet-btn-secondary w-full py-2 text-sm">
            Back to wallets
          </button>
        </div>
      </section>
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
              <p className="text-sm wallet-muted">Enter this wallet file's password.</p>
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
                    <p className="font-semibold wallet-text-strong">{w.wallet_name || `Wallet #${w.id}`}</p>
                  </div>
                  <button
                    onClick={() => handleOpenClick(w.id)}
                    className="wallet-btn-secondary px-4 py-1.5 text-sm"
                  >
                    Open
                  </button>
                </div>

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
                    {bioEnrolledId === w.id && (
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

        <div className="space-y-2">
          <p className="text-sm wallet-muted">{wallets && wallets.length > 0 ? 'Add another wallet' : 'Get started'}</p>
          <Link to="/createwallet" className="wallet-btn-primary w-full block text-center py-3 font-bold">
            Create New Wallet
          </Link>
          <Link to="/importwallet" className="wallet-btn-secondary w-full block text-center py-3 font-bold">
            Import Wallet
          </Link>
          <button
            onClick={() => setView('hardware')}
            className="wallet-btn-secondary w-full text-center py-3 font-bold"
          >
            Connect Hardware Wallet
          </button>
        </div>
      </div>
    </section>
  );
};

export default DesktopLandingPage;
