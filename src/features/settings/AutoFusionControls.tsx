// The single auto-fusion policy governing BOTH Fusion transports.
//
// Rendered once, directly under the Server/P2P mode chooser, rather than copied
// into each card. Server Fusion and P2P Fusion are two transports for one
// feature and are mutually exclusive, so there is only ever one policy in play —
// a second copy of these controls could only ever agree with the first or be a
// bug, and the bug would stay invisible until a round ran with the wrong bound.

import React from 'react';
import { useDispatch, useSelector } from 'react-redux';

import {
  MAX_FUSE_DEPTH,
  MIN_FUSE_DEPTH,
  selectAutoFuseEnabled,
  selectFuseDepth,
  setAutoFuseEnabled,
  setFuseDepth,
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

  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between gap-2">
        <span>
          <span className="text-xs font-semibold wallet-text-strong">
            Fuse automatically
          </span>
          <span className="block text-[10px] wallet-muted">
            Starts rounds on its own using the selected transport. Each round
            pays a network fee.
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
            Rounds per coin
          </span>
          <span className="block text-[10px] wallet-muted">
            A coin stops being picked up once it has been fused this many times.
          </span>
        </span>
        <input
          type="number"
          min={MIN_FUSE_DEPTH}
          max={MAX_FUSE_DEPTH}
          step={1}
          value={depth}
          disabled={disabled}
          // Commit on change so both cards move together immediately. The
          // reducer clamps, so a pasted 0 or 99 cannot reach the engine.
          onChange={(event) => dispatch(setFuseDepth(Number(event.target.value)))}
          className="w-16 shrink-0 rounded-lg border border-[var(--wallet-border)] bg-transparent px-2 py-1 text-right text-xs wallet-text-strong disabled:opacity-50"
        />
      </label>
    </div>
  );
}

export default AutoFusionControls;
