import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { AppDispatch } from '../../state/store';
import { selectAutoLockMinutes, setAutoLockMinutes } from '../../state/slices/appLockSlice';
import { selectWalletId, resetWallet } from '../../state/slices/walletSlice';
import { ROUTE_PATHS } from '../../navigation/routes';
import { OptnKeyManager } from './OptnKeyManager';
import {
  changeWalletPassword,
  isBiometricAvailable,
  hasWalletBiometric,
  enableWalletBiometric,
  disableWalletBiometric,
  getBiometricLabel,
  verifyWalletPassword,
} from './DesktopWalletManager';
import {
  isWalletPasswordLongEnough,
  validateNewWalletPassword,
} from './passwordPolicy';

// A CashFusion round takes minutes and dies with the key when the wallet
// locks, so sub-15-minute choices are unusable while fusing and were removed.
// Default is Never (spend re-auth + 10 min cache when set to Never). A locked
// wallet must still actually lock — do not suppress the timer mid-round.
const AUTO_LOCK_OPTIONS = [
  { label: 'Never', value: 0 },
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '2 hours', value: 120 },
  { label: '4 hours', value: 240 },
];

export const AppLockSettings: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const autoLockMinutes = useSelector(selectAutoLockMinutes);
  const walletId = useSelector(selectWalletId);

  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  // Password set / change form
  const [oldPass, setOldPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [changing, setChanging] = useState(false);
  /** True when empty string unlocks this wallet (no password set yet). */
  const [hasNoPassword, setHasNoPassword] = useState<boolean | null>(null);

  // Biometric unlock
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricLabel, setBiometricLabel] = useState('Biometric unlock');
  const [biometricPassword, setBiometricPassword] = useState('');
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [biometricError, setBiometricError] = useState('');
  const [showBiometricPrompt, setShowBiometricPrompt] = useState(false);

  useEffect(() => {
    void (async () => {
      const available = await isBiometricAvailable();
      setBiometricAvailable(available);
      if (available) setBiometricLabel(getBiometricLabel());
      setBiometricEnabled(walletId > 0 ? await hasWalletBiometric(walletId) : false);
    })();
  }, [walletId]);

  useEffect(() => {
    let cancelled = false;
    setHasNoPassword(null);
    if (!walletId || walletId <= 0) {
      setHasNoPassword(null);
      return;
    }
    void (async () => {
      try {
        const emptyOk = await verifyWalletPassword(walletId, '');
        if (!cancelled) setHasNoPassword(emptyOk);
      } catch {
        if (!cancelled) setHasNoPassword(false);
      }
    })();
    return () => {
      cancelled = true;
    };
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
        setBiometricError('Current password is incorrect.');
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
      setBiometricError(`Biometric setup failed: ${msg}`);
    } finally {
      setBiometricBusy(false);
    }
  };

  const handleLockNow = () => {
    // Close this wallet: wipe its key, clear the open-wallet id, return to picker.
    OptnKeyManager.lock();
    dispatch(resetWallet());
    navigate(ROUTE_PATHS.landing);
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setStatus('');

    if (!walletId) {
      setError('No wallet is open.');
      return;
    }

    // First-time set: require a real password (≥8). Change may set empty again.
    if (hasNoPassword) {
      if (!isWalletPasswordLongEnough(newPass)) {
        setError('Use at least 8 characters for a new password.');
        return;
      }
      if (newPass !== confirmPass) {
        setError('Passwords do not match.');
        return;
      }
    } else {
      const passErr = validateNewWalletPassword(newPass, confirmPass);
      if (passErr) {
        setError(passErr);
        return;
      }
    }

    setChanging(true);
    try {
      // Set/change ONLY this wallet (EC model). Empty oldPass when hasNoPassword.
      const ok = await changeWalletPassword(
        walletId,
        hasNoPassword ? '' : oldPass,
        newPass
      );
      if (!ok) {
        setError(
          hasNoPassword
            ? 'Could not set password. Try again.'
            : 'Current password is incorrect.'
        );
        return;
      }
      setOldPass('');
      setNewPass('');
      setConfirmPass('');
      const nowEmpty = newPass.length === 0;
      setHasNoPassword(nowEmpty);
      setStatus(
        hasNoPassword
          ? 'Password set successfully.'
          : nowEmpty
            ? 'Password removed.'
            : 'Password changed successfully.'
      );
      clearStatus();
    } catch (err) {
      console.error('[AppLockSettings] Password update failed:', err);
      setError(
        hasNoPassword
          ? 'Could not set password. Please try again.'
          : 'Password change failed. Please try again.'
      );
    } finally {
      setChanging(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">

      {/* Encryption info */}
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-1">
        <p className="text-sm font-semibold wallet-text-strong">Encryption</p>
        <p className="text-xs wallet-muted">
          Your wallet is encrypted with a password-derived key (PBKDF2 · 600k iterations · AES-256-GCM).
          The key is never stored — it is derived in memory each time you unlock.
        </p>
      </div>

      {/* Set password (no password yet) vs Change password */}
      <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-3">
        <p className="text-sm font-semibold wallet-text-strong">
          {hasNoPassword === null
            ? 'Password'
            : hasNoPassword
              ? 'Set a password'
              : 'Change password'}
        </p>
        <form
          onSubmit={(e) => void handlePasswordSubmit(e)}
          className="flex flex-col gap-2"
        >
          {hasNoPassword === true && (
            <p className="text-xs wallet-muted">
              This wallet has no password. Choose one with at least 8 characters.
            </p>
          )}
          {hasNoPassword === false && (
            <p className="text-xs wallet-muted">
              Enter your current password, then a new one (empty = remove
              password, or at least 8 characters).
            </p>
          )}
          {hasNoPassword === false && (
            <input
              type="password"
              value={oldPass}
              onChange={(e) => {
                setOldPass(e.target.value);
                setError('');
              }}
              placeholder="Current password"
              className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
            />
          )}
          <input
            type="password"
            value={newPass}
            onChange={(e) => {
              setNewPass(e.target.value);
              setError('');
            }}
            placeholder={
              hasNoPassword
                ? 'Password (min 8 characters)'
                : 'New password (empty = none, or min 8)'
            }
            className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
          />
          <input
            type="password"
            value={confirmPass}
            onChange={(e) => {
              setConfirmPass(e.target.value);
              setError('');
            }}
            placeholder={
              hasNoPassword ? 'Confirm password' : 'Confirm new password'
            }
            className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          {status && <p className="text-xs text-green-400">{status}</p>}
          <button
            type="submit"
            disabled={changing || hasNoPassword === null}
            className="w-full rounded-xl py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: 'var(--wallet-accent, #6366f1)' }}
          >
            {changing
              ? 'Updating…'
              : hasNoPassword
                ? 'Set password'
                : 'Change password'}
          </button>
        </form>
      </div>

      {/* Biometric unlock */}
      {biometricAvailable && (
        <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold wallet-text-strong">Biometric unlock</p>
              <p className="text-xs wallet-muted">Use {biometricLabel} to unlock instead of typing your password.</p>
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
              {biometricBusy ? '…' : biometricEnabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>

          {showBiometricPrompt && (
            <form onSubmit={(e) => void handleBiometricEnableConfirm(e)} className="flex flex-col gap-2">
              <input
                type="password"
                value={biometricPassword}
                onChange={(e) => { setBiometricPassword(e.target.value); setBiometricError(''); }}
                placeholder="Current password"
                autoFocus
                className="w-full rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-sm wallet-text-strong placeholder:wallet-muted outline-none focus:ring-1 focus:ring-[var(--wallet-accent)]"
              />
              {biometricError && <p className="text-xs text-red-400">{biometricError}</p>}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setShowBiometricPrompt(false); setBiometricPassword(''); setBiometricError(''); }}
                  className="flex-1 rounded-xl py-2 text-sm font-medium wallet-muted border border-[var(--wallet-border)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    biometricBusy ||
                    (!hasNoPassword && !biometricPassword)
                  }
                  className="flex-1 rounded-xl py-2 text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: 'var(--wallet-accent, #6366f1)' }}
                >
                  {biometricBusy ? 'Enabling…' : 'Confirm'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Auto-lock interval */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold wallet-text-strong">Auto-lock after</p>
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
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Lock Now */}
      <button
        onClick={handleLockNow}
        className="w-full rounded-xl border border-[var(--wallet-accent)] py-2.5 text-sm font-semibold text-[var(--wallet-accent)] hover:opacity-80"
      >
        Lock Now
      </button>
    </div>
  );
};
