import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { AppDispatch } from '../../state/store';
import {
  selectAutoLockMinutes,
  setAutoLockMinutes,
} from '../../state/slices/appLockSlice';
import { selectWalletId, resetWallet } from '../../state/slices/walletSlice';
import { ROUTE_PATHS } from '../../navigation/routes';
import { EcKeyManager } from './EcKeyManager';
import {
  changeWalletPassword,
  isBiometricAvailable,
  hasWalletBiometric,
  enableWalletBiometric,
  disableWalletBiometric,
  getBiometricLabel,
} from './DesktopWalletManager';
import { useI18n } from '../../i18n/useI18n';

const AUTO_LOCK_OPTIONS = [
  { value: 0 },
  { value: 1 },
  { value: 5 },
  { value: 15 },
  { value: 30 },
];

export const AppLockSettings: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const autoLockMinutes = useSelector(selectAutoLockMinutes);
  const walletId = useSelector(selectWalletId);
  const { t } = useI18n();

  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  // Password change form
  const [oldPass, setOldPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [changing, setChanging] = useState(false);

  // Biometric unlock
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricLabel, setBiometricLabel] = useState(() =>
    t('settingsAppLock.biometricUnlock')
  );
  const [biometricPassword, setBiometricPassword] = useState('');
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [biometricError, setBiometricError] = useState('');
  const [showBiometricPrompt, setShowBiometricPrompt] = useState(false);

  useEffect(() => {
    void (async () => {
      const available = await isBiometricAvailable();
      setBiometricAvailable(available);
      if (available) setBiometricLabel(getBiometricLabel());
      setBiometricEnabled(
        walletId > 0 ? await hasWalletBiometric(walletId) : false
      );
    })();
  }, [walletId]);

  const clearStatus = () => setTimeout(() => setStatus(''), 3000);

  const handleBiometricToggle = async () => {
    setBiometricError('');
    if (!walletId) return;
    if (biometricEnabled) {
      setBiometricBusy(true);
      try {
        await disableWalletBiometric(walletId);
        setBiometricEnabled(false);
      } finally {
        setBiometricBusy(false);
      }
      return;
    }
    setShowBiometricPrompt(true);
  };

  const handleBiometricEnableConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!walletId) return;
    setBiometricBusy(true);
    setBiometricError('');
    try {
      // Verifies this wallet's password, then stores it behind the OS biometric.
      const ok = await enableWalletBiometric(walletId, biometricPassword);
      if (!ok) {
        setBiometricError(t('settingsAppLock.currentPasswordIncorrect'));
        return;
      }
      setBiometricEnabled(true);
      setShowBiometricPrompt(false);
      setBiometricPassword('');
    } catch (err) {
      // Surface the actual OS error — a "credentialCreationFailed" here means
      // Windows Hello / Touch ID isn't set up on this machine (enroll it in the
      // OS settings first), not a bug in the wallet.
      console.error('[AppLockSettings] Enable biometric failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      setBiometricError(
        t('settingsAppLock.biometricSetupFailed', { message: msg })
      );
    } finally {
      setBiometricBusy(false);
    }
  };

  const handleLockNow = () => {
    // Close this wallet: wipe its key, clear the open-wallet id, return to picker.
    EcKeyManager.lock();
    dispatch(resetWallet());
    navigate(ROUTE_PATHS.landing);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setStatus('');

    if (!walletId) {
      setError(t('settingsAppLock.noWalletOpen'));
      return;
    }
    if (newPass !== confirmPass) {
      setError(t('settingsAppLock.passwordMismatch'));
      return;
    }

    setChanging(true);
    try {
      // Change ONLY the currently-open wallet's password (Electron Cash model:
      // each wallet is independent). changeWalletPassword verifies the old
      // password against THIS wallet's own data — no app-wide gate involved.
      const ok = await changeWalletPassword(walletId, oldPass, newPass);
      if (!ok) {
        setError(t('settingsAppLock.currentPasswordIncorrect'));
        return;
      }
      setOldPass('');
      setNewPass('');
      setConfirmPass('');
      setStatus(t('settingsAppLock.passwordChanged'));
      clearStatus();
    } catch (err) {
      console.error('[AppLockSettings] Password change failed:', err);
      setError(t('settingsAppLock.passwordChangeFailed'));
    } finally {
      setChanging(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Encryption info */}
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-1">
        <p className="text-sm font-semibold wallet-text-strong">
          {t('settingsAppLock.encryption')}
        </p>
        <p className="text-xs wallet-muted">
          {t('settingsAppLock.encryptionDescription')}
        </p>
      </div>

      {/* Change password */}
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-3">
        <p className="text-sm font-semibold wallet-text-strong">
          {t('settingsAppLock.changePassword')}
        </p>
        <form
          onSubmit={(e) => void handleChangePassword(e)}
          className="flex flex-col gap-2"
        >
          <input
            type="password"
            value={oldPass}
            onChange={(e) => {
              setOldPass(e.target.value);
              setError('');
            }}
            placeholder={t('settingsAppLock.currentPassword')}
            className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
          />
          <input
            type="password"
            value={newPass}
            onChange={(e) => {
              setNewPass(e.target.value);
              setError('');
            }}
            placeholder={t('settingsAppLock.newPassword')}
            className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
          />
          <input
            type="password"
            value={confirmPass}
            onChange={(e) => {
              setConfirmPass(e.target.value);
              setError('');
            }}
            placeholder={t('settingsAppLock.confirmNewPassword')}
            className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          {status && <p className="text-xs text-green-400">{status}</p>}
          <button
            type="submit"
            disabled={changing || !oldPass}
            className="w-full rounded-xl py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: 'var(--wallet-accent, #6366f1)' }}
          >
            {changing
              ? t('settingsAppLock.updating')
              : t('settingsAppLock.changePassword')}
          </button>
        </form>
      </div>

      {/* Biometric unlock */}
      {biometricAvailable && (
        <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold wallet-text-strong">
                {t('settingsAppLock.biometricUnlock')}
              </p>
              <p className="text-xs wallet-muted">
                {t('settingsAppLock.biometricDescription', {
                  label: biometricLabel,
                })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleBiometricToggle()}
              disabled={biometricBusy}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                biometricEnabled
                  ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)]'
                  : 'border-[var(--wallet-border)] wallet-muted hover:wallet-text-strong'
              }`}
            >
              {biometricBusy
                ? '…'
                : biometricEnabled
                  ? t('settingsAppLock.enabled')
                  : t('settingsAppLock.disabled')}
            </button>
          </div>

          {showBiometricPrompt && (
            <form
              onSubmit={(e) => void handleBiometricEnableConfirm(e)}
              className="flex flex-col gap-2"
            >
              <input
                type="password"
                value={biometricPassword}
                onChange={(e) => {
                  setBiometricPassword(e.target.value);
                  setBiometricError('');
                }}
                placeholder={t('settingsAppLock.currentPassword')}
                autoFocus
                className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
              />
              {biometricError && (
                <p className="text-xs text-red-400">{biometricError}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowBiometricPrompt(false);
                    setBiometricPassword('');
                    setBiometricError('');
                  }}
                  className="flex-1 rounded-xl py-2 text-sm font-medium wallet-muted border border-[var(--wallet-border)]"
                >
                  {t('settingsAppLock.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={biometricBusy || !biometricPassword}
                  className="flex-1 rounded-xl py-2 text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: 'var(--wallet-accent, #6366f1)' }}
                >
                  {biometricBusy
                    ? t('settingsAppLock.enabling')
                    : t('settingsAppLock.confirm')}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Auto-lock interval */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold wallet-text-strong">
          {t('settingsAppLock.autoLockAfter')}
        </p>
        <div className="flex flex-wrap gap-2">
          {AUTO_LOCK_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => dispatch(setAutoLockMinutes(opt.value))}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                autoLockMinutes === opt.value
                  ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)]'
                  : 'border-[var(--wallet-border)] wallet-muted hover:wallet-text-strong'
              }`}
            >
              {opt.value === 0
                ? t('settingsAppLock.never')
                : opt.value === 1
                  ? t('settingsAppLock.minute')
                  : t('settingsAppLock.minutes', { count: opt.value })}
            </button>
          ))}
        </div>
      </div>

      {/* Lock Now */}
      <button
        onClick={handleLockNow}
        className="w-full rounded-xl border border-[var(--wallet-accent)] py-2.5 text-sm font-semibold text-[var(--wallet-accent)] hover:opacity-80"
      >
        {t('settingsAppLock.lockNow')}
      </button>
    </div>
  );
};
