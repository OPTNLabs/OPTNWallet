/**
 * Settings → Wallet & security → Wallet info
 *
 * Public summary always visible; derivation path / account xpub / fingerprint /
 * wallet hash sit behind an eye toggle that requires wallet password or
 * biometric (desktop), so shoulder-surfing cannot copy identifying key material.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { binToHex, sha256 } from '@bitauth/libauth';
import { MdVisibility, MdVisibilityOff, MdContentCopy } from 'react-icons/md';
import WalletManager from '../../apis/WalletManager/WalletManager';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import {
  selectWalletDerivationPath,
  selectWalletId,
  selectWalletType,
} from '../../state/slices/walletSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import {
  getBchAccountPath,
  deriveHdPublicKeyAtPath,
} from '../../services/HdWalletService';
import { isDesktopPlatform } from '../../utils/platform';
import { WATCH_ONLY_WALLET_TYPE } from '../../platform/desktop/onboarding/watchOnlyWallet';
import { HARDWARE_WALLET_TYPE } from '../../platform/desktop/onboarding/hardwareWallet';
import type { ExtendedWalletType } from '../../types/wallet';

type WalletInfoSnapshot = {
  name: string;
  walletType: string;
  network: string;
  derivationPath: string;
  accountXpub: string | null;
  masterFingerprint: string | null;
  walletHash: string | null;
  firstReceive: string | null;
};

function typeLabel(t: string | null | undefined): string {
  if (t === WATCH_ONLY_WALLET_TYPE) return 'Watch-only';
  if (t === HARDWARE_WALLET_TYPE) return 'Hardware';
  if (t === 'quantumroot') return 'Quantumroot';
  return 'Standard';
}

function hashXpub(xpub: string): string {
  return binToHex(sha256.hash(new TextEncoder().encode(xpub.trim())));
}

async function readDesktopColumns(
  walletId: number
): Promise<{ accountXpub: string | null; masterFingerprint: string | null }> {
  try {
    const { ensureDesktopWalletColumns } = await import(
      '../../platform/desktop/desktopSchema'
    );
    await ensureDesktopWalletColumns();
  } catch {
    /* non-desktop */
  }
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return { accountXpub: null, masterFingerprint: null };
  try {
    const q = db.prepare(
      `SELECT account_xpub, master_fingerprint FROM wallets WHERE id = ?`
    );
    q.bind([walletId]);
    if (!q.step()) {
      q.free();
      return { accountXpub: null, masterFingerprint: null };
    }
    const row = q.getAsObject() as Record<string, unknown>;
    q.free();
    return {
      accountXpub:
        typeof row.account_xpub === 'string' && row.account_xpub.trim()
          ? row.account_xpub.trim()
          : null,
      masterFingerprint:
        typeof row.master_fingerprint === 'string' &&
        row.master_fingerprint.trim()
          ? row.master_fingerprint.trim().toLowerCase()
          : null,
    };
  } catch {
    return { accountXpub: null, masterFingerprint: null };
  }
}

async function deriveAccountXpubFromSeed(
  walletId: number,
  network: Parameters<typeof getBchAccountPath>[0],
  accountPath: string
): Promise<string | null> {
  try {
    const info = await WalletManager().getWalletInfo(walletId);
    const mnemonic =
      info && typeof info.mnemonic === 'string' ? info.mnemonic : null;
    if (!mnemonic || mnemonic.startsWith('enc:')) return null;
    const passphrase =
      info && typeof info.passphrase === 'string' ? info.passphrase : '';
    return await deriveHdPublicKeyAtPath(
      mnemonic,
      passphrase,
      network,
      accountPath
    );
  } catch {
    return null;
  }
}

async function loadFirstReceive(walletId: number): Promise<string | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;
  try {
    const q = db.prepare(
      `SELECT address FROM keys
       WHERE wallet_id = ? AND change_index = 0 AND address_index = 0
       LIMIT 1`
    );
    q.bind([walletId]);
    if (!q.step()) {
      q.free();
      return null;
    }
    const row = q.getAsObject() as { address?: string };
    q.free();
    return typeof row.address === 'string' ? row.address : null;
  } catch {
    return null;
  }
}

async function loadSnapshot(
  walletId: number,
  network: Parameters<typeof getBchAccountPath>[0],
  reduxPath: string,
  walletType: ExtendedWalletType | string
): Promise<WalletInfoSnapshot> {
  const meta = await WalletManager().getWalletMetadata(walletId);
  const name =
    (meta?.wallet_name && meta.wallet_name.trim()) || `Wallet ${walletId}`;
  const path =
    (meta?.derivation_path && meta.derivation_path.trim()) ||
    (reduxPath && reduxPath.trim()) ||
    getBchAccountPath(network);
  const cols = await readDesktopColumns(walletId);
  let accountXpub = cols.accountXpub;
  if (!accountXpub) {
    accountXpub = await deriveAccountXpubFromSeed(walletId, network, path);
  }
  const firstReceive = await loadFirstReceive(walletId);
  return {
    name,
    walletType: typeLabel(meta?.walletType ?? walletType),
    network: meta?.networkType ?? network,
    derivationPath: path,
    accountXpub,
    masterFingerprint: cols.masterFingerprint,
    walletHash: accountXpub ? hashXpub(accountXpub) : null,
    firstReceive,
  };
}

async function renameWallet(walletId: number, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Give the wallet a name.');
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) throw new Error('Wallet database is unavailable.');
  db.run('UPDATE wallets SET wallet_name = ? WHERE id = ?', [trimmed, walletId]);
  try {
    await dbService.flushDatabaseToFile(walletId);
  } catch {
    await dbService.saveDatabaseToFile(walletId);
  }
}

async function authorizeReveal(walletId: number): Promise<boolean> {
  if (!isDesktopPlatform()) {
    return window.confirm(
      'Show derivation path, account xPub, and wallet hash for this wallet?'
    );
  }
  try {
    const {
      verifyWalletPassword,
      hasWalletBiometric,
      isBiometricAvailable,
      getBiometricLabel,
    } = await import('../../platform/desktop/DesktopWalletManager');

    // Prefer enrolled biometric: OS prompt returns the stored wallet password,
    // which we only verify — we do not re-open / switch the active session.
    if ((await isBiometricAvailable()) && (await hasWalletBiometric(walletId))) {
      try {
        const { getData: bioGetData } = await import(
          '@choochmeque/tauri-plugin-biometry-api'
        );
        const result = await bioGetData({
          domain: 'com.optilabs.wallet',
          name: `optn-wallet-bio-${walletId}`,
          reason: 'Show wallet xPub and identity details',
        });
        if (result.data && (await verifyWalletPassword(walletId, result.data))) {
          return true;
        }
      } catch {
        // Cancelled or failed — fall through to typed password.
      }
    }

    const label = (await isBiometricAvailable())
      ? getBiometricLabel()
      : 'password';
    const typed = window.prompt(
      `Enter this wallet's password to show xPub and identity details.\n` +
        `(You can also enroll ${label} under App Lock for a quicker unlock.)`
    );
    if (typed === null) return false;
    const ok = await verifyWalletPassword(walletId, typed);
    if (!ok) {
      window.alert('Wrong wallet password.');
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[WalletInfoSettings] authorizeReveal failed:', err);
    return window.confirm(
      'Could not verify password. Show sensitive wallet details anyway?'
    );
  }
}

function CopyRow({
  label,
  value,
  mono,
  secret,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  secret?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const display = value && value.trim() ? value : '—';
  const canCopy = Boolean(value && value.trim());

  const onCopy = async () => {
    if (!canCopy || !value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold wallet-muted uppercase tracking-wide">
          {label}
        </p>
        {canCopy && (
          <button
            type="button"
            onClick={() => void onCopy()}
            className="inline-flex items-center gap-1 text-xs wallet-link"
            title="Copy"
          >
            <MdContentCopy className="text-sm" />
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      <p
        className={`text-sm wallet-text-strong break-all ${
          mono || secret ? 'font-mono text-xs leading-relaxed' : ''
        }`}
      >
        {display}
      </p>
    </div>
  );
}

export const WalletInfoSettings: React.FC = () => {
  const walletId = useSelector(selectWalletId);
  const network = useSelector(selectCurrentNetwork);
  const walletType = useSelector(selectWalletType);
  const reduxPath = useSelector(selectWalletDerivationPath);

  const [info, setInfo] = useState<WalletInfoSnapshot | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameMsg, setNameMsg] = useState('');

  const reload = useCallback(async () => {
    if (!walletId || walletId <= 0) {
      setInfo(null);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const snap = await loadSnapshot(
        walletId,
        network,
        reduxPath,
        walletType
      );
      setInfo(snap);
      setNameDraft(snap.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load wallet info.');
    } finally {
      setBusy(false);
    }
  }, [walletId, network, reduxPath, walletType]);

  useEffect(() => {
    void reload();
    setRevealed(false);
  }, [reload]);

  // Hide secrets when leaving the panel / switching wallet.
  useEffect(() => {
    return () => setRevealed(false);
  }, [walletId]);

  const toggleReveal = async () => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    if (!walletId) return;
    setBusy(true);
    setError('');
    try {
      const ok = await authorizeReveal(walletId);
      if (!ok) return;
      // Reload after auth so seed-backed xpubs decrypt under a fresh key session.
      await reload();
      setRevealed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reveal details.');
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    if (!walletId) return;
    setNameMsg('');
    try {
      await renameWallet(walletId, nameDraft);
      setEditingName(false);
      setNameMsg('Name saved.');
      await reload();
      window.dispatchEvent(new CustomEvent('optn:wallets-changed'));
      setTimeout(() => setNameMsg(''), 2500);
    } catch (err) {
      setNameMsg(err instanceof Error ? err.message : 'Could not rename.');
    }
  };

  if (!walletId || walletId <= 0) {
    return (
      <p className="text-sm wallet-muted">Open a wallet to view its identity.</p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold wallet-text-strong">Wallet info</p>
        <p className="text-xs wallet-muted mt-1">
          Name, type, and network are always visible. Only xPub and related
          identity fields use the eye lock (password or biometric).
        </p>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {busy && !info && (
        <p className="text-xs wallet-muted">Loading wallet info…</p>
      )}

      {info && (
        <div className="space-y-2.5">
          {/* Always public — never eye-gated */}
          <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3 space-y-2">
            <p className="text-xs font-semibold wallet-muted uppercase tracking-wide">
              Wallet name
            </p>
            {editingName ? (
              <div className="flex flex-col gap-2">
                <input
                  className="wallet-input w-full text-sm"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  maxLength={64}
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="wallet-btn-primary flex-1 py-2 text-sm"
                    onClick={() => void saveName()}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="wallet-btn-secondary flex-1 py-2 text-sm"
                    onClick={() => {
                      setEditingName(false);
                      setNameDraft(info.name);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold wallet-text-strong">
                  {info.name}
                </p>
                <button
                  type="button"
                  className="text-xs wallet-link"
                  onClick={() => setEditingName(true)}
                >
                  Rename
                </button>
              </div>
            )}
            {nameMsg && (
              <p className="text-xs wallet-muted">{nameMsg}</p>
            )}
          </div>

          <CopyRow label="Wallet id" value={String(walletId)} />
          <CopyRow label="Type" value={info.walletType} />
          <CopyRow label="Network" value={info.network} />

          {/* Eye only covers xPub / path / fingerprint / hash */}
          <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold wallet-text-strong">
                  Key identity
                </p>
                <p className="text-xs wallet-muted">
                  xPub, path, fingerprint, hash — hidden until unlocked
                </p>
              </div>
              <button
                type="button"
                onClick={() => void toggleReveal()}
                disabled={busy}
                className="shrink-0 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--wallet-border)] wallet-surface-strong text-[var(--wallet-accent-strong)] hover:brightness-[1.04] disabled:opacity-50"
                title={
                  revealed
                    ? 'Hide xPub and identity fields'
                    : 'Show xPub and identity fields (password or biometric)'
                }
                aria-label={
                  revealed ? 'Hide key identity' : 'Show key identity'
                }
                aria-pressed={revealed}
              >
                {revealed ? (
                  <MdVisibility className="text-xl" />
                ) : (
                  <MdVisibilityOff className="text-xl" />
                )}
              </button>
            </div>

            {!revealed ? (
              <div className="rounded-xl border border-dashed border-[var(--wallet-border)] p-4 text-center space-y-2">
                <MdVisibilityOff className="mx-auto text-2xl wallet-muted" />
                <p className="text-sm wallet-muted">
                  Account xPub, derivation path, master fingerprint, and wallet
                  hash are locked.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void toggleReveal()}
                  className="wallet-btn-secondary px-4 py-2 text-sm font-semibold"
                >
                  {busy ? 'Checking…' : 'Unlock with password / biometric'}
                </button>
              </div>
            ) : (
              <div className="space-y-2.5">
                <CopyRow
                  label="Derivation path"
                  value={info.derivationPath}
                  mono
                />
                <CopyRow
                  label="Account xPub"
                  value={info.accountXpub}
                  mono
                  secret
                />
                <CopyRow
                  label="Master fingerprint"
                  value={info.masterFingerprint}
                  mono
                />
                <CopyRow
                  label="Wallet hash"
                  value={info.walletHash}
                  mono
                  secret
                />
                <CopyRow
                  label="First receive address"
                  value={info.firstReceive}
                  mono
                />
                {!info.accountXpub && (
                  <p className="text-xs wallet-muted">
                    No account xPub available (seed not readable in this
                    session, or this wallet type does not store one). Watch-only
                    and hardware wallets keep the xPub used at import.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default WalletInfoSettings;
