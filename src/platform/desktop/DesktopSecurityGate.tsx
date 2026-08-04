// DesktopSecurityGate — EC-model passphrase gate for the desktop build.
//
// Renders one of four states before children are shown:
//   loading  — checking OS keychain on first mount
//   setup    — no passphrase found; first-time setup form
//   locked   — passphrase exists but key not in RAM (restart or inactivity lock)
//   ready    — key is loaded; renders children normally
//
// Passphrase is mandatory — the app cannot be used without one.
// An empty passphrase is accepted (PBKDF2 still runs; provides OS-account protection).

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch } from '../../state/store';
import {
  selectIsLocked,
  unlockApp,
  setPassphraseConfigured,
} from '../../state/slices/appLockSlice';
import { EcKeyManager } from './EcKeyManager';
import { useI18n } from '../../i18n/useI18n';

type GateState = 'loading' | 'setup' | 'locked' | 'ready';

interface Props {
  children: React.ReactNode;
}

export const DesktopSecurityGate: React.FC<Props> = ({ children }) => {
  const dispatch = useDispatch<AppDispatch>();
  const { t } = useI18n();
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
      if (EcKeyManager.isUnlocked()) {
        setGateState('ready');
        return;
      }
      const setup = await EcKeyManager.hasSetup();
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
        EcKeyManager.isBiometricAvailable(),
        EcKeyManager.hasBiometricEnrolled(),
      ]);
      if (!cancelled) setBiometricOffered(available && enrolled);
    })();
    return () => {
      cancelled = true;
    };
  }, [gateState]);

  // ── Biometric unlock ──────────────────────────────────────────────────────

  const handleBiometricUnlock = useCallback(async () => {
    setBiometricBusy(true);
    setError('');
    try {
      const ok = await EcKeyManager.unlockWithBiometric();
      if (ok) {
        dispatch(unlockApp());
        setGateState('ready');
        setPassphrase('');
      } else {
        setError(t('desktopSecurity.biometricFailed'));
      }
    } catch (err) {
      console.error('[DesktopSecurityGate] Biometric unlock error:', err);
      setError(t('desktopSecurity.biometricFailed'));
    } finally {
      setBiometricBusy(false);
    }
  }, [dispatch, t]);

  // When Redux signals a lock (inactivity), transition to locked state.
  useEffect(() => {
    if (isLockedRedux && gateState === 'ready') {
      EcKeyManager.lock();
      setGateState('locked');
      setPassphrase('');
      setPassphraseConfirm('');
      setError('');
    }
  }, [isLockedRedux, gateState]);

  // ── First-time setup ──────────────────────────────────────────────────────

  const handleSetup = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (passphrase !== passphraseConfirm) {
        setError(t('desktopSecurity.mismatch'));
        return;
      }
      setBusy(true);
      setError('');
      try {
        await EcKeyManager.setup(passphrase);
        dispatch(setPassphraseConfigured(true));
        dispatch(unlockApp());
        setGateState('ready');
        setPassphrase('');
        setPassphraseConfirm('');
      } catch (err) {
        console.error('[DesktopSecurityGate] Setup error:', err);
        setError(t('desktopSecurity.saveFailed'));
      } finally {
        setBusy(false);
      }
    },
    [passphrase, passphraseConfirm, dispatch, t]
  );

  // ── Unlock ────────────────────────────────────────────────────────────────

  const handleUnlock = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError('');
      try {
        const ok = await EcKeyManager.unlock(passphrase);
        if (ok) {
          dispatch(unlockApp());
          setGateState('ready');
          setPassphrase('');
        } else {
          setError(t('desktopSecurity.incorrect'));
        }
      } catch (err) {
        console.error('[DesktopSecurityGate] Unlock error:', err);
        setError(t('desktopSecurity.unlockFailed'));
      } finally {
        setBusy(false);
      }
    },
    [passphrase, dispatch, t]
  );

  // ── Loading ───────────────────────────────────────────────────────────────

  if (gateState === 'loading') {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[var(--wallet-bg,#0f0f0f)]">
        <div className="text-sm wallet-muted animate-pulse">
          {t('desktopSecurity.loading')}
        </div>
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
            <h2 className="text-lg font-bold wallet-text-strong">
              {t('desktopSecurity.secureWallet')}
            </h2>
            <p className="text-sm wallet-muted">
              {t('desktopSecurity.setupDescription')}
            </p>
          </div>

          <form onSubmit={handleSetup} className="space-y-3">
            <input
              type="password"
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setError('');
              }}
              placeholder={t('desktopSecurity.passwordPlaceholder')}
              autoFocus
              className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-4 py-3 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-2 focus:ring-[var(--wallet-accent)]"
            />
            <input
              type="password"
              value={passphraseConfirm}
              onChange={(e) => {
                setPassphraseConfirm(e.target.value);
                setError('');
              }}
              placeholder={t('desktopSecurity.confirmPassword')}
              className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-4 py-3 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-2 focus:ring-[var(--wallet-accent)]"
            />
            {error && (
              <p className="text-sm text-red-400 text-center">{error}</p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl py-3 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: 'var(--wallet-accent, #6366f1)' }}
            >
              {busy
                ? t('desktopSecurity.securing')
                : t('desktopSecurity.continue')}
            </button>
          </form>

          <p className="text-xs wallet-muted text-center">
            {t('desktopSecurity.passwordNeverStored')}
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
            <h2 className="text-lg font-bold wallet-text-strong">
              {t('desktopSecurity.walletLocked')}
            </h2>
            <p className="text-sm wallet-muted">
              {t('desktopSecurity.enterPassword')}
            </p>
          </div>

          {biometricOffered && (
            <button
              type="button"
              onClick={() => void handleBiometricUnlock()}
              disabled={biometricBusy}
              className="w-full flex items-center justify-center gap-2 rounded-xl border border-[var(--wallet-border)] py-3 text-sm font-medium wallet-text-strong disabled:opacity-50"
            >
              <span className="text-lg">👆</span>
              <span>
                {biometricBusy
                  ? t('desktopSecurity.authenticating')
                  : t('desktopSecurity.useBiometric', {
                      label: EcKeyManager.getBiometricLabel(),
                    })}
              </span>
            </button>
          )}

          <form onSubmit={handleUnlock} className="space-y-3">
            <input
              type="password"
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setError('');
              }}
              placeholder={t('desktopSecurity.password')}
              autoFocus
              className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-4 py-3 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-2 focus:ring-[var(--wallet-accent)]"
              onKeyDown={(e) => {
                if (e.key === 'Enter')
                  void handleUnlock(e as unknown as React.FormEvent);
              }}
            />
            {error && (
              <p className="text-sm text-red-400 text-center">{error}</p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl py-3 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: 'var(--wallet-accent, #6366f1)' }}
            >
              {busy
                ? t('desktopSecurity.unlocking')
                : t('desktopSecurity.unlock')}
            </button>
          </form>
          <p className="text-xs wallet-muted text-center">
            {t('desktopSecurity.forgotPassword')}
          </p>
        </div>
      </div>
    );
  }

  // ── Ready — render children ───────────────────────────────────────────────

  return <>{children}</>;
};
