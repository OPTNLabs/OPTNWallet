/**
 * Desktop updates: which releases this holder wants to hear about, and whether
 * one is waiting.
 *
 * Two independent opt-ins rather than a single picker, because that is what
 * they mean: beta adds the builds cut from staging, alpha adds the unfinished
 * ones, and neither is on until asked for. Someone who ticks both is on alpha,
 * which already includes the rest.
 *
 * Installing is offered only when this build can verify what it would run.
 * A signed release is checked against the public key compiled into the
 * application before a byte of it executes; a build with no key gets no
 * install button at all, only the release link. There is deliberately no third
 * state -- "install without verifying" is the flag that turns up set in a
 * release.
 */

import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import SectionCard from '../../components/ui/SectionCard';
import {
  checkForUpdate,
  installUpdate,
  type UpdateCheck,
} from '../../platform/desktop/updateBridge';
import {
  selectUpdateAlpha,
  selectUpdateBeta,
  setUpdateAlpha,
  setUpdateBeta,
} from '../../state/slices/preferencesSlice';

export default function AppUpdateSettings() {
  const dispatch = useDispatch();
  const beta = useSelector(selectUpdateBeta);
  const alpha = useSelector(selectUpdateAlpha);

  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState('');
  const [error, setError] = useState('');

  // One check on open, so the screen is not a button that must be pressed to
  // say anything. Re-run when the channel changes: the answer depends on it.
  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    setError('');
    checkForUpdate(beta, alpha)
      .then((value) => {
        if (!cancelled) setResult(value);
      })
      .catch((failure) => {
        if (!cancelled) {
          setError(
            failure instanceof Error ? failure.message : String(failure)
          );
        }
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [beta, alpha]);

  const channelLabel =
    result?.channel === 'alpha'
      ? 'Alpha — everything, including unfinished builds'
      : result?.channel === 'beta'
        ? 'Beta — releases cut from staging'
        : 'Stable — finished releases only';

  return (
    <div className="space-y-4">
      <SectionCard title="Version">
        <p className="wallet-muted text-sm">
          Running <span className="font-mono">{result?.current ?? '…'}</span> ·{' '}
          {channelLabel}
        </p>

        {checking && (
          <p className="wallet-muted mt-2 text-xs">Checking for updates…</p>
        )}

        {!checking && result?.unavailable && (
          <p
            className="mt-2 text-xs text-amber-400"
            data-testid="update-blocked"
          >
            {result.unavailable}
          </p>
        )}

        {!checking && !result?.unavailable && result?.available && (
          <div
            className="mt-2 rounded-lg border border-[var(--wallet-warning-border)] bg-[var(--wallet-warning-bg)] px-3 py-2 text-xs text-[var(--wallet-warning-text)]"
            data-testid="update-available"
          >
            <p>
              <span className="font-mono">{result.available}</span> is
              available.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {result.verified_install && (
                <button
                  type="button"
                  disabled={installing}
                  data-testid="install-update"
                  className="wallet-btn-primary px-3 py-1.5 text-xs"
                  onClick={() => {
                    setInstalling(true);
                    setError('');
                    installUpdate()
                      .then((version) =>
                        setInstalled(
                          `${version} installed. Restart the wallet to use it.`
                        )
                      )
                      .catch((failure) =>
                        setError(
                          failure instanceof Error
                            ? failure.message
                            : String(failure)
                        )
                      )
                      .finally(() => setInstalling(false));
                  }}
                >
                  {installing ? 'Verifying and installing…' : 'Install update'}
                </button>
              )}
              <a
                href={result.releases_url}
                target="_blank"
                rel="noopener noreferrer"
                className="wallet-btn-secondary inline-block px-3 py-1.5 text-xs"
              >
                Open the release page ↗
              </a>
            </div>
            {installed && <p className="mt-2">{installed}</p>}
          </div>
        )}

        {!checking && !result?.unavailable && result && !result.available && (
          <p className="wallet-muted mt-2 text-xs" data-testid="update-current">
            This is the newest release on your channel.
          </p>
        )}

        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

        <button
          type="button"
          disabled={checking}
          data-testid="check-for-updates"
          className="wallet-btn-secondary mt-3 px-3 py-1.5 text-xs"
          onClick={() => {
            setChecking(true);
            setError('');
            checkForUpdate(beta, alpha)
              .then(setResult)
              .catch((failure) =>
                setError(
                  failure instanceof Error ? failure.message : String(failure)
                )
              )
              .finally(() => setChecking(false));
          }}
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>

        <p className="wallet-muted mt-2 text-xs">
          {result?.verified_install
            ? 'Updates are verified against a signing key built into this ' +
              'application before anything is run. A download whose signature ' +
              'does not match is refused, not warned about.'
            : 'This build cannot verify updates, so it will not install one. ' +
              'It reports what is available and opens the release page, and ' +
              'you install deliberately — a one-click installer with nothing ' +
              'to check the download against would be a way to run unverified ' +
              'code on your machine.'}
        </p>
      </SectionCard>

      <SectionCard title="Pre-release channels">
        <p className="wallet-muted text-sm">
          Off by default. Pre-release builds are published for testing and can
          contain defects that reach funds.
        </p>

        <label className="mt-3 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={beta}
            data-testid="opt-in-beta"
            onChange={(event) => dispatch(setUpdateBeta(event.target.checked))}
          />
          <span>
            <span className="block">Include beta releases</span>
            <span className="wallet-muted text-xs">
              Builds cut from staging, ahead of the finished release.
            </span>
          </span>
        </label>

        <label className="mt-3 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={alpha}
            data-testid="opt-in-alpha"
            onChange={(event) => dispatch(setUpdateAlpha(event.target.checked))}
          />
          <span>
            <span className="block">Include alpha releases</span>
            <span className="wallet-muted text-xs">
              Unfinished work. Includes beta as well.
            </span>
          </span>
        </label>
      </SectionCard>
    </div>
  );
}
