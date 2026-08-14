// DesktopSecurityGate — EC-model passphrase gate for the desktop build.
//
// Renders one of four states before children are shown:
//   loading  — checking OS keychain on first mount
//   setup    — no passphrase found; first-time setup form
//   locked   — passphrase exists but key not in RAM (restart or inactivity lock)
//   ready    — key is loaded; renders children normally
//
// Passphrase is mandatory — the app cannot be used without one.
// Min length matches extension + per-wallet policy (blank is no longer accepted).

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch } from '../../state/store';
import {
  selectIsLocked,
  unlockApp,
  setPassphraseConfigured,
} from '../../state/slices/appLockSlice';
import { OptnKeyManager } from './OptnKeyManager';
import { validateNewWalletPassword } from './passwordPolicy';

type GateState = 'loading' | 'setup' | 'locked' | 'ready';

interface Props {
  children: React.ReactNode;
}

export const DesktopSecurityGate: React.FC<Props> = ({ children }) => {
  const dispatch = useDispatch<AppDispatch>();
  const isLockedRedux = useSelector(selectIsLocked);

  const [gateState, setGateState] = useState<GateState>('loading');
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [biometricOffered, setBiometricOffered] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const initialised = useRef(false);

  // Determine gate state on mount.
  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;

    void (async () => {
      if (OptnKeyManager.isUnlocked()) {
        setGateState('ready');
        return;
      }
      const setup = await OptnKeyManager.hasSetup();
      if (setup) {
        setGateState('locked');
      } else {
        setGateState('setup');
      }
    })();
  }, []);

  // Check biometric availability whenever we land on the locked screen.
  useEffect(() => {
    if (gateState !== 'locked') return;
    let cancelled = false;
    void (async () => {
      const [available, enrolled] = await Promise.all([
        OptnKeyManager.isBiometricAvailable(),
        OptnKeyManager.hasBiometricEnrolled(),
      ]);
      if (!cancelled) setBiometricOffered(available && enrolled);
    })();
    return () => { cancelled = true; };
  }, [gateState]);

  // ── Biometric unlock ──────────────────────────────────────────────────────

  const handleBiometricUnlock = useCallback(async () => {
    setBiometricBusy(true);
    setError('');
    try {
      const ok = await OptnKeyManager.unlockWithBiometric();
      if (ok) {
        dispatch(unlockApp());
        setGateState('ready');
        setPassphrase('');
      } else {
        setError('Biometric unlock failed. Use your password.');
      }
    } catch (err) {
      console.error('[DesktopSecurityGate] Biometric unlock error:', err);
      setError('Biometric unlock failed. Use your password.');
    } finally {
      setBiometricBusy(false);
    }
  }, [dispatch]);

  // When Redux signals a lock (inactivity), transition to locked state.
  useEffect(() => {
    if (isLockedRedux && gateState === 'ready') {
      OptnKeyManager.lock();
      setGateState('locked');
      setPassphrase('');
      setPassphraseConfirm('');
      setError('');
    }
  }, [isLockedRedux, gateState]);

  // ── First-time setup ──────────────────────────────────────────────────────

  const handleSetup = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const passErr = validateNewWalletPassword(passphrase, passphraseConfirm);
    if (passErr) {
      setError(passErr);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await OptnKeyManager.setup(passphrase);
      dispatch(setPassphraseConfigured(true));
      dispatch(unlockApp());
      setGateState('ready');
      setPassphrase('');
      setPassphraseConfirm('');
    } catch (err) {
      console.error('[DesktopSecurityGate] Setup error:', err);
      setError('Failed to save passphrase. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [passphrase, passphraseConfirm, dispatch]);

  // ── Unlock ────────────────────────────────────────────────────────────────

  const handleUnlock = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const ok = await OptnKeyManager.unlock(passphrase);
      if (ok) {
        dispatch(unlockApp());
        setGateState('ready');
        setPassphrase('');
      } else {
        setError('Incorrect passphrase. Please try again.');
      }
    } catch (err) {
      console.error('[DesktopSecurityGate] Unlock error:', err);
      setError('Unlock failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [passphrase, dispatch]);

  // ── Loading ───────────────────────────────────────────────────────────────

  if (gateState === 'loading') {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[var(--wallet-bg,#0f0f0f)]">
        <div className="text-sm wallet-muted animate-pulse">Loading wallet…</div>
      </div>
    );
  }

  // ── Setup form ────────────────────────────────────────────────────────────

  if (gateState === 'setup') {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[var(--wallet-bg,#0f0f0f)] p-4">
        <div className="wallet-card w-full max-w-sm p-6 space-y-5">
          <div className="text-center space-y-1">
            <div className="text-3xl mb-2">🔐</div>
            <h2 className="text-lg font-bold wallet-text-strong">Secure your wallet</h2>
            <p className="text-sm wallet-muted">
              Set a password (at least 8 characters) to encrypt wallet secrets.
              You will need it every time you open the app.
            </p>
          </div>

          <form onSubmit={handleSetup} className="space-y-3">
            <input
              type="password"
              value={passphrase}
              onChange={(e) => { setPassphrase(e.target.value); setError(''); }}
              placeholder="Password (min 8 characters)"
              autoComplete="new-password"
              autoFocus
              className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-4 py-3 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-2 focus:ring-[var(--wallet-accent)]"
            />
            <input
              type="password"
              value={passphraseConfirm}
              onChange={(e) => { setPassphraseConfirm(e.target.value); setError(''); }}
              placeholder="Confirm password"
              autoComplete="new-password"
              className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-4 py-3 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-2 focus:ring-[var(--wallet-accent)]"
            />
            {error && <p className="text-sm text-red-400 text-center">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl py-3 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: 'var(--wallet-accent, #6366f1)' }}
            >
              {busy ? 'Securing…' : 'Continue'}
            </button>
          </form>

          <p className="text-xs wallet-muted text-center">
            Your password is never stored — it derives your encryption key locally.
            Blank or short passwords are not allowed: they do not protect seeds at rest.
          </p>
        </div>
      </div>
    );
  }

  // ── Unlock form ───────────────────────────────────────────────────────────

  if (gateState === 'locked') {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[var(--wallet-bg,#0f0f0f)] p-4">
        <div className="wallet-card w-full max-w-sm p-6 space-y-5">
          <div className="text-center space-y-1">
            <div className="text-3xl mb-2">🔒</div>
            <h2 className="text-lg font-bold wallet-text-strong">Wallet locked</h2>
            <p className="text-sm wallet-muted">Enter your password to unlock.</p>
          </div>

          {biometricOffered && (
            <button
              type="button"
              onClick={() => void handleBiometricUnlock()}
              disabled={biometricBusy}
              className="w-full flex items-center justify-center gap-2 rounded-xl border border-[var(--wallet-border)] py-3 text-sm font-medium wallet-text-strong disabled:opacity-50"
            >
              <span className="text-lg">👆</span>
              <span>{biometricBusy ? 'Authenticating…' : `Use ${OptnKeyManager.getBiometricLabel()}`}</span>
            </button>
          )}

          <form onSubmit={handleUnlock} className="space-y-3">
            <input
              type="password"
              value={passphrase}
              onChange={(e) => { setPassphrase(e.target.value); setError(''); }}
              placeholder="Password"
              autoFocus
              className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-4 py-3 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-2 focus:ring-[var(--wallet-accent)]"
              onKeyDown={(e) => { if (e.key === 'Enter') void handleUnlock(e as unknown as React.FormEvent); }}
            />
            {error && <p className="text-sm text-red-400 text-center">{error}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl py-3 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: 'var(--wallet-accent, #6366f1)' }}
            >
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
          </form>
          <p className="text-xs wallet-muted text-center">
            Forgot your password? Remove the wallet and re-import your seed phrase.
          </p>
        </div>
      </div>
    );
  }

  // ── Ready — render children ───────────────────────────────────────────────

  return <>{children}</>;
};
