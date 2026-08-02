import React from 'react';
import { P2P_PHASE_LABELS } from '../../platform/desktop/FusionP2pService';

// The P2P CashFusion panel inside the CashFusion settings card. Presentational:
// the parent (CashFusionSettings) owns Tor resolution + the runP2pFusion call and
// passes the start handler, live phase (1–5), and status down.
interface P2pFusionPanelProps {
  onStart: () => void;
  status: string | null;
  phase: number; // 0 = idle, 1..5 = live round steps (see P2P_PHASE_LABELS)
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
}

// The five live steps, 00-Wallet style (labels come from P2P_PHASE_LABELS[1..5]).
const STEPS = P2P_PHASE_LABELS.slice(1);

export const P2pFusionTransportPreview: React.FC<P2pFusionPanelProps> = ({
  onStart,
  status,
  phase,
  busy,
  disabled,
  disabledReason,
}) => (
  <div className="space-y-2.5 rounded-xl border border-violet-400/20 bg-violet-400/5 p-3">
    <p className="text-xs font-semibold text-violet-400">P2P Fusion over Nostr</p>
    <p className="text-[10px] leading-relaxed wallet-muted">
      No server: peers meet on Nostr relays over Tor, deterministically elect a
      coordinator, and run the CoinJoin peer-to-peer. Outputs are unlinkable
      (throwaway keys + Tor); you sign only your own inputs, and only after
      verifying your own outputs are present — a hostile coordinator can never make
      you sign away funds.
    </p>

    {/* Live 1–5 stepper */}
    <ol className="space-y-1">
      {STEPS.map((label, i) => {
        const step = i + 1;
        const done = phase > step;
        const active = phase === step;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-[8px] font-bold ${
                done
                  ? 'bg-green-400/80 text-black'
                  : active
                    ? 'bg-violet-400 text-black'
                    : 'border border-[var(--wallet-border)] wallet-muted'
              }`}
            >
              {done ? '✓' : step}
            </span>
            <span className={`text-[10px] ${active ? 'font-semibold text-violet-400' : done ? 'wallet-text-strong' : 'wallet-muted'}`}>
              {label}
              {active && busy ? '…' : ''}
            </span>
          </li>
        );
      })}
    </ol>

    <button
      type="button"
      onClick={onStart}
      disabled={disabled || busy}
      className="w-full rounded-xl border border-violet-400/40 px-3 py-2 text-xs font-semibold text-violet-400 hover:bg-violet-400/5 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? 'Fusing…' : 'Start P2P round'}
    </button>

    {disabled && disabledReason ? (
      <p className="text-center text-[9px] wallet-muted">{disabledReason}</p>
    ) : (
      <p className="text-center text-[9px] wallet-muted">
        Requires Tor + at least 2 peers in the same tier.
      </p>
    )}

    {status && (
      <p className="break-all text-center text-[10px] leading-relaxed wallet-muted">{status}</p>
    )}
  </div>
);
