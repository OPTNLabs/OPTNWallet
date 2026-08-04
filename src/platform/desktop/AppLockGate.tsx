// AppLockGate: manages inactivity auto-lock and the passphrase integrity-check modal.
//
// EC model responsibilities:
//   1. Inactivity timer — after the idle period, wipes the open wallet's in-RAM
//      key and navigates back to the wallet picker. There is no app-level lock
//      screen: reopening the wallet asks that wallet's own password.
//   2. optn:integrity-check events — gated seed-phrase reveal: shows passphrase confirm modal,
//      calls EcKeyManager.verify() without updating the cached key (verify-only path).

import React, { useEffect, useRef, useCallback, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { selectAutoLockMinutes } from '../../state/slices/appLockSlice';
import { selectWalletId, resetWallet } from '../../state/slices/walletSlice';
import { ROUTE_PATHS } from '../../navigation/routes';
import { EcKeyManager } from './EcKeyManager';
import { verifyWalletPassword } from './DesktopWalletManager';
import {
  INTEGRITY_EVENT,
  resolveIntegrityCheck,
  rejectIntegrityCheck,
} from './DeviceIntegrityService';
import { useI18n } from '../../i18n/useI18n';

const ACTIVITY_EVENTS = [
  'mousemove',
  'mousedown',
  'keydown',
  'touchstart',
  'scroll',
] as const;

export const AppLockGate: React.FC = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { t } = useI18n();
  const autoLockMinutes = useSelector(selectAutoLockMinutes);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const walletId = useSelector(selectWalletId);
  // Only arm the idle timer while a wallet is actually open — on the landing
  // picker there is nothing unlocked to protect, and locking there just
  // wipes the cached key the picker itself needs.
  const shouldAutoLock = autoLockMinutes > 0 && !!walletId;

  // ── Integrity passphrase confirmation state ────────────────────────────────

  const [integrityVisible, setIntegrityVisible] = useState(false);
  const [integrityPassphrase, setIntegrityPassphrase] = useState('');
  const [integrityError, setIntegrityError] = useState('');
  const [integrityChecking, setIntegrityChecking] = useState(false);

  // ── Inactivity auto-lock ──────────────────────────────────────────────────

  const resetTimer = useCallback(() => {
    if (!shouldAutoLock) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(
      () => {
        console.log(
          `[AppLock] No activity for ${autoLockMinutes} min — closing wallet`
        );
        EcKeyManager.lock();
        dispatch(resetWallet());
        navigate(ROUTE_PATHS.landing);
      },
      autoLockMinutes * 60 * 1000
    );
  }, [shouldAutoLock, autoLockMinutes, navigate, dispatch]);

  useEffect(() => {
    if (shouldAutoLock) resetTimer();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [shouldAutoLock, resetTimer]);

  useEffect(() => {
    if (!shouldAutoLock) return;
    const handleActivity = () => resetTimer();
    ACTIVITY_EVENTS.forEach((e) =>
      window.addEventListener(e, handleActivity, { passive: true })
    );
    return () => {
      ACTIVITY_EVENTS.forEach((e) =>
        window.removeEventListener(e, handleActivity)
      );
    };
  }, [shouldAutoLock, resetTimer]);

  // ── Integrity check event listener ────────────────────────────────────────

  useEffect(() => {
    const handler = () => {
      setIntegrityPassphrase('');
      setIntegrityError('');
      setIntegrityVisible(true);
    };
    window.addEventListener(INTEGRITY_EVENT, handler);
    return () => window.removeEventListener(INTEGRITY_EVENT, handler);
  }, []);

  // ── Integrity check handlers ──────────────────────────────────────────────

  const handleIntegritySubmit = useCallback(async () => {
    setIntegrityChecking(true);
    setIntegrityError('');
    try {
      const ok = walletId
        ? await verifyWalletPassword(walletId, integrityPassphrase)
        : false;
      if (ok) {
        setIntegrityVisible(false);
        resolveIntegrityCheck();
      } else {
        setIntegrityError(t('appLock.incorrect'));
      }
    } catch {
      setIntegrityError(t('appLock.verificationFailed'));
    } finally {
      setIntegrityChecking(false);
      setIntegrityPassphrase('');
    }
  }, [integrityPassphrase, walletId, t]);

  const handleIntegrityCancel = useCallback(() => {
    setIntegrityVisible(false);
    setIntegrityPassphrase('');
    setIntegrityError('');
    rejectIntegrityCheck('Cancelled by user');
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  if (!integrityVisible) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleIntegrityCancel}
    >
      <div
        className="wallet-card w-full max-w-xs mx-4 p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-center space-y-1">
          <div className="text-2xl">🔐</div>
          <h3 className="font-bold text-lg wallet-text-strong">
            {t('appLock.confirmPassword')}
          </h3>
          <p className="text-sm wallet-muted">{t('appLock.revealBackup')}</p>
        </div>

        <input
          type="password"
          value={integrityPassphrase}
          onChange={(e) => setIntegrityPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleIntegritySubmit();
          }}
          placeholder={t('appLock.password')}
          className="w-full rounded-[14px] border border-[var(--wallet-border)] bg-transparent px-4 py-3 text-center text-lg outline-none wallet-surface-strong"
          autoFocus
        />

        {integrityError && (
          <p className="text-center text-sm wallet-danger-text">
            {integrityError}
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            className="flex-1 wallet-btn-secondary"
            onClick={handleIntegrityCancel}
          >
            {t('appLock.cancel')}
          </button>
          <button
            type="button"
            className="flex-1 wallet-btn-danger"
            onClick={() => void handleIntegritySubmit()}
            disabled={integrityChecking}
          >
            {integrityChecking ? t('appLock.checking') : t('appLock.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};
