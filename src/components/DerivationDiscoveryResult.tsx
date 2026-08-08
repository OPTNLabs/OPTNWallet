// Present a derivation-path scan. Shared by wallet import and settings so both
// say the same thing about the same result.
//
// Two rules drive the copy here:
//
// 1. "Nothing found" and "could not check" must never look alike. They lead to
//    opposite actions — accept the default, or try again before deciding.
// 2. When more than one path holds coins the wallet must not choose. Picking
//    one silently hides the other's money, so the user is asked.

import React from 'react';

import type { DerivationDiscoveryState } from '../hooks/useDerivationDiscovery';
import type { PathProbeResult } from '../services/DerivationPathDiscovery';

interface Props {
  state: DerivationDiscoveryState;
  /** Path the wallet would use if the scan is ignored. */
  currentPath: string;
  /** Network default, used to keep a successful default import silent. */
  defaultPath?: string;
  /** Explicit choice when an ambiguous result remains visible. */
  selectedPath?: string | null;
  onAdopt: (path: string) => void;
  onCancel: () => void;
  onRetry: () => void;
  /** Wording differs slightly before a wallet exists. */
  context: 'import' | 'settings';
}

function formatBch(satoshis: bigint): string {
  const whole = satoshis / 100_000_000n;
  const fraction = (satoshis % 100_000_000n).toString().padStart(8, '0');
  return `${whole.toString()}.${fraction.replace(/0+$/, '') || '0'} BCH`;
}

function describeFunding(probe: PathProbeResult): string {
  const addresses = `${probe.usedAddresses} address${probe.usedAddresses === 1 ? '' : 'es'}`;
  return probe.satoshis > 0n
    ? `${formatBch(probe.satoshis)} across ${addresses}`
    : `no balance, ${addresses} used before`;
}

const Note: React.FC<{
  tone?: 'muted' | 'success' | 'danger';
  children: React.ReactNode;
}> = ({ tone = 'muted', children }) => {
  const toneClass =
    tone === 'success'
      ? 'text-[var(--wallet-success-text)]'
      : tone === 'danger'
        ? 'wallet-danger-text'
        : 'wallet-muted';
  return <p className={`text-xs leading-relaxed ${toneClass}`}>{children}</p>;
};

export const DerivationDiscoveryResult: React.FC<Props> = ({
  state,
  currentPath,
  defaultPath,
  selectedPath = null,
  onAdopt,
  onCancel,
  onRetry,
  context,
}) => {
  if (state.status === 'idle') return null;

  if (state.status === 'scanning') {
    const label =
      state.total > 0
        ? `Checking derivation paths… (${state.completed} of ${state.total})`
        : 'Checking derivation paths…';
    return (
      <div className="flex flex-col gap-2">
        <Note>{label}</Note>
        <button
          type="button"
          onClick={onCancel}
          className="wallet-btn-secondary self-start"
        >
          Skip this check
        </button>
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div className="flex flex-col gap-2">
        <Note tone="danger">{state.message}</Note>
        <Note>
          {context === 'import'
            ? `You can import on ${currentPath} and change it later in Settings.`
            : 'Your current path is unchanged.'}
        </Note>
        <button
          type="button"
          onClick={onRetry}
          className="wallet-btn-secondary self-start"
        >
          Try again
        </button>
      </div>
    );
  }

  const { result } = state;
  const funded = result.probed.filter((probe) => probe.satoshis > 0n);

  // A partial answer is not safe to act on. Even when one checked path has
  // history, an unchecked path may hold more coins. Keep retry ahead of every
  // adoption branch so a transport failure can never become a path decision.
  if (result.incomplete) {
    return (
      <div className="flex flex-col gap-2">
        <Note tone="danger">
          Could not check {result.candidatesTotal - result.candidatesProbed} of{' '}
          {result.candidatesTotal} derivation paths — the server did not
          respond. This does not mean they are empty.
        </Note>
        <button
          type="button"
          onClick={onRetry}
          className="wallet-btn-secondary self-start"
        >
          Try again
        </button>
      </div>
    );
  }

  // With a current balance, list every funded path. If all balances are zero,
  // ambiguity means more than one path has prior history, so list those paths
  // instead. Address-chain continuity still belongs to the user.
  const ambiguousCandidates =
    funded.length > 1
      ? funded
      : result.probed.filter((probe) => probe.usedAddresses > 0);

  if (result.ambiguous && ambiguousCandidates.length > 1) {
    return (
      <div className="flex flex-col gap-3">
        <Note tone="danger">
          This recovery phrase has wallet history on more than one derivation
          path. A wallet can only use one at a time — pick the one you want now.
          The others stay untouched on chain and you can switch later.
        </Note>
        <div className="flex flex-col gap-2">
          {ambiguousCandidates.map((probe) => (
            <button
              key={probe.path}
              type="button"
              onClick={() => onAdopt(probe.path)}
              aria-pressed={selectedPath === probe.path}
              className="wallet-btn-secondary flex flex-col items-start gap-1 text-left"
            >
              <span className="flex w-full items-center justify-between gap-3">
                <span className="font-mono text-sm">{probe.path}</span>
                {selectedPath === probe.path && (
                  <span className="text-xs font-semibold">Selected</span>
                )}
              </span>
              <span className="text-xs wallet-muted">
                {describeFunding(probe)}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (result.chosen) {
    if (result.chosen === currentPath) {
      // The common import case is deliberately silent. A non-default path was
      // auto-adopted, however, so explain why the visible field changed.
      if (context === 'import' && result.chosen === defaultPath) return null;

      const chosenProbe = result.probed.find(
        (probe) => probe.path === result.chosen
      );
      return (
        <Note tone="success">
          {context === 'import' ? (
            <>
              Found this phrase&apos;s history on{' '}
              <span className="font-mono">{result.chosen}</span>
              {chosenProbe ? ` — ${describeFunding(chosenProbe)}.` : '.'} Using
              this path for import.
            </>
          ) : (
            'Checked other derivation paths — your current path is correct.'
          )}
        </Note>
      );
    }

    const chosenProbe = result.probed.find(
      (probe) => probe.path === result.chosen
    );
    return (
      <div className="flex flex-col gap-2">
        <Note tone="success">
          Found this phrase&apos;s history on{' '}
          <span className="font-mono">{result.chosen}</span>
          {chosenProbe ? ` — ${describeFunding(chosenProbe)}.` : '.'}
        </Note>
        <Note>
          {context === 'import'
            ? 'Import using that path so your coins appear.'
            : 'Switching clears local records and resyncs on the new path.'}
        </Note>
        <button
          type="button"
          onClick={() => onAdopt(result.chosen as string)}
          className="wallet-btn-primary self-start"
        >
          Use {result.chosen}
        </button>
      </div>
    );
  }

  return (
    <Note>
      No transaction history on any standard derivation path. That is expected
      for a new recovery phrase.{' '}
      {context === 'import'
        ? `Importing on ${currentPath}.`
        : 'Keeping your current path.'}
    </Note>
  );
};

export default DerivationDiscoveryResult;
