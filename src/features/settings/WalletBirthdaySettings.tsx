import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { engineHandleFor } from '../../platform/desktop/engineWalletBridge';

type Birthday =
  | { kind: 'unknown' }
  | { kind: 'height'; height: number }
  | { kind: 'time'; requested_time: number };
type Status = {
  active: string | null;
  epoch: number;
  restore_birthday: null | {
    kind: string;
    height?: number;
    requested_time?: number;
  };
  manual_rescan_from: number | null;
};

/** Presentation only: Rust validates the epoch and persists restore metadata. */
export function WalletBirthdaySettings({ walletId }: { walletId: number }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [kind, setKind] = useState<Birthday['kind']>('unknown');
  const [value, setValue] = useState('');
  const [seconds, setSeconds] = useState<number | null>(null);
  const [confirmation, setConfirmation] = useState<'birthday' | 'clear' | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    setConfirmation(null);
    void Promise.all([
      engineHandleFor(walletId),
      invoke<Status>('optn_wallet_security', {
        request: { command: 'status' },
      }),
    ])
      .then(([handle, current]) => {
        if (cancelled) return;
        if (!handle || current.active !== handle || !current.restore_birthday) {
          setError(
            'Unlock this wallet in the shared runtime before changing its birthday.'
          );
          return;
        }
        setStatus(current);
      })
      .catch((failure) => {
        if (!cancelled) setError(String(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [walletId]);

  const height = /^\d+$/.test(value) ? Number(value) : NaN;
  const birthday: Birthday | null =
    kind === 'unknown'
      ? { kind }
      : kind === 'height'
        ? Number.isSafeInteger(height) && height >= 0 && height <= 0xffffffff
          ? { kind, height }
          : null
        : seconds !== null &&
            Number.isInteger(seconds) &&
            seconds >= 0 &&
            seconds <= 0xffffffff
          ? { kind, requested_time: seconds }
          : null;
  const saved = status?.restore_birthday;
  const save = async () => {
    if (
      !status ||
      !confirmation ||
      busy ||
      (confirmation === 'birthday' && !birthday)
    )
      return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const current = await invoke<Status>('optn_wallet_security', {
        request:
          confirmation === 'clear'
            ? { command: 'clear_rescan', epoch: status.epoch }
            : { command: 'set_birthday', epoch: status.epoch, birthday },
      });
      setStatus(current);
      setConfirmation(null);
      setMessage(
        'History start saved. Existing balances remain cached until synchronization completes.'
      );
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3" aria-label="Wallet birthday">
      <p className="text-sm wallet-text-strong">
        {saved?.kind === 'unknown'
          ? 'Saved birthday: unknown — full history.'
          : saved?.kind === 'created_at'
            ? `Recorded creation: block ${saved.height}.`
            : saved?.kind === 'imported_at_height'
              ? `Saved birthday: block ${saved.height}.`
              : saved?.kind === 'imported_at_time' &&
                  saved.requested_time !== undefined
                ? `Saved birthday: ${new Date(saved.requested_time * 1000).toISOString().slice(0, 10)} (UTC).`
                : 'Reading wallet birthday…'}
      </p>
      <p className="text-xs wallet-muted">
        Choose Unknown if you do not know when this wallet first received funds.
        A later birthday can hide earlier funds and history. A manual rescan
        override is separate and takes precedence.
      </p>
      {status?.manual_rescan_from != null && (
        <p className="text-xs wallet-muted">
          Manual rescan override: block {status.manual_rescan_from}.
        </p>
      )}
      <label className="block text-sm wallet-text-strong">
        Wallet history start
        <select
          className="wallet-input w-full rounded-xl px-3 py-2"
          disabled={!status || busy}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as Birthday['kind']);
            setValue('');
            setSeconds(null);
            setConfirmation(null);
          }}
        >
          <option value="unknown">Unknown — full history</option>
          <option value="height">Block height</option>
          <option value="time">Date (UTC)</option>
        </select>
      </label>
      {kind === 'height' && (
        <label className="block text-sm wallet-text-strong">
          Earliest block
          <input
            className="wallet-input w-full rounded-xl px-3 py-2"
            inputMode="numeric"
            value={value}
            disabled={busy}
            onChange={(event) => {
              setValue(event.target.value);
              setConfirmation(null);
            }}
          />
        </label>
      )}
      {kind === 'time' && (
        <label className="block text-sm wallet-text-strong">
          Earliest date (UTC)
          <input
            className="wallet-input w-full rounded-xl px-3 py-2"
            type="date"
            disabled={busy}
            onChange={(event) => {
              setSeconds(
                Number.isFinite(event.target.valueAsNumber)
                  ? event.target.valueAsNumber / 1000
                  : null
              );
              setConfirmation(null);
            }}
          />
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm wallet-muted">
          {message}
        </p>
      )}
      {confirmation ? (
        <div className="space-y-2">
          <p className="text-sm wallet-text-strong">
            {confirmation === 'clear'
              ? 'Remove the manual rescan override and use the saved birthday?'
              : 'Save this birthday? History before it may be skipped.'}
          </p>
          <button
            className="wallet-btn-primary px-3 py-2"
            disabled={busy}
            onClick={() => void save()}
          >
            Confirm history start
          </button>
          <button
            className="wallet-btn-secondary px-3 py-2"
            disabled={busy}
            onClick={() => setConfirmation(null)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            className="wallet-btn-primary px-3 py-2"
            disabled={!status || !birthday || busy}
            onClick={() => setConfirmation('birthday')}
          >
            Review birthday change
          </button>
          {status?.manual_rescan_from != null && (
            <button
              className="wallet-btn-secondary px-3 py-2"
              onClick={() => setConfirmation('clear')}
            >
              Use saved birthday
            </button>
          )}
        </div>
      )}
    </section>
  );
}
