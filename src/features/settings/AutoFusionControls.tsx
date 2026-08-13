// The single auto-fusion policy governing BOTH Fusion transports.
//
// Rendered once, directly under the Server/P2P mode chooser, rather than copied
// into each card. Server Fusion and P2P Fusion are two transports for one
// feature and are mutually exclusive, so there is only ever one policy in play.

import React from 'react';
import { useDispatch, useSelector } from 'react-redux';

import {
  MAX_FUSE_DEPTH,
  MIN_FUSE_DEPTH,
  selectAutoFuseEnabled,
  selectFuseDepth,
  selectSpendOnlyFusedCoins,
  setAutoFuseEnabled,
  setFuseDepth,
  setSpendOnlyFusedCoins,
} from '../../state/slices/experimentalSlice';

interface AutoFusionControlsProps {
  /** No wallet open, etc. */
  disabled?: boolean;
}

export function AutoFusionControls({
  disabled = false,
}: AutoFusionControlsProps): React.ReactElement {
  const dispatch = useDispatch();
  const autoFuse = useSelector(selectAutoFuseEnabled);
  const depth = useSelector(selectFuseDepth);
  const spendOnlyFused = useSelector(selectSpendOnlyFusedCoins);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-[var(--wallet-border)] bg-[var(--wallet-surface)]/50 px-3 py-2 text-[10px] wallet-muted leading-relaxed">
        <p className="font-semibold wallet-text-strong text-[11px] mb-1">
          How these settings fit together
        </p>
        <ul className="list-disc pl-4 space-y-0.5">
          <li>
            <span className="wallet-text-strong">Fuse automatically</span> —
            start rounds in the background (on UTXO refresh + timer). Needs Tor
            for P2P and peers online.
          </li>
          <li>
            <span className="wallet-text-strong">Rounds per coin</span> — how
            many times Auto fuses each coin before it stops (default 3). Auto
            always uses this number. Change it to restart: raise to fuse more,
            lower to stop sooner.
          </li>
          <li>
            <span className="wallet-text-strong">Only spend fused coins</span>{' '}
            — ordinary Send may only use coins that already have depth ≥ 1.
            Fresh receives wait for fusion first (Electron Cash–style).
          </li>
        </ul>
      </div>

      <label className="flex items-center justify-between gap-2">
        <span>
          <span className="text-xs font-semibold wallet-text-strong">
            Fuse automatically
          </span>
          <span className="block text-[10px] wallet-muted">
            Starts rounds on its own using the selected transport (P2P or
            server). Each successful round pays a network fee; then waits ~40s
            before Auto tries again (~25s after a failed attempt).
          </span>
        </span>
        <input
          type="checkbox"
          checked={autoFuse}
          disabled={disabled}
          onChange={(event) =>
            dispatch(setAutoFuseEnabled(event.target.checked))
          }
          className="h-4 w-4 shrink-0 accent-[var(--wallet-accent)] disabled:opacity-50"
        />
      </label>

      <label className="flex items-center justify-between gap-2">
        <span>
          <span className="text-xs font-semibold wallet-text-strong">
            Rounds per coin (fuse depth)
          </span>
          <span className="block text-[10px] wallet-muted">
            Auto keeps fusing each coin until it reaches this count (default 3).
            “All coins already at depth” means Auto is done for this number —
            not broken. Change the number and Auto restarts against the new
            target. New send/receive coins start at 0 and fuse again. Manual
            Start ignores this limit.
          </span>
        </span>
        <input
          type="number"
          min={MIN_FUSE_DEPTH}
          max={MAX_FUSE_DEPTH}
          step={1}
          value={depth}
          disabled={disabled}
          onChange={(event) => dispatch(setFuseDepth(Number(event.target.value)))}
          className="w-16 shrink-0 rounded-lg border border-[var(--wallet-border)] bg-transparent px-2 py-1 text-right text-xs wallet-text-strong disabled:opacity-50"
        />
      </label>

      <label className="flex items-center justify-between gap-2">
        <span>
          <span className="text-xs font-semibold wallet-text-strong">
            Only spend fused coins
          </span>
          <span className="block text-[10px] wallet-muted">
            Send (and Max) refuse unfused coins. Fuse first, or turn this off
            to spend fresh receives.
          </span>
        </span>
        <input
          type="checkbox"
          checked={spendOnlyFused}
          disabled={disabled}
          onChange={(event) =>
            dispatch(setSpendOnlyFusedCoins(event.target.checked))
          }
          className="h-4 w-4 shrink-0 accent-[var(--wallet-accent)] disabled:opacity-50"
        />
      </label>
    </div>
  );
}

export default AutoFusionControls;
