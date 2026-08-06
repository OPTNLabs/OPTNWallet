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
    <div className="mt-2 rounded-lg border border-violet-400/20 bg-violet-400/5 px-2.5 py-2 text-[10px] wallet-muted leading-relaxed space-y-1">
      <p className="font-semibold text-violet-300/90">Privacy stack (always on)</p>
      <ul className="list-disc pl-3.5 space-y-0.5">
        <li>
          <span className="wallet-text-strong">Tor</span> — hide your IP from
          relays
        </li>
        <li>
          <span className="wallet-text-strong">NIP-59 gift-wrap</span> — encrypt
          round messages on Nostr
        </li>
        <li>
          <span className="wallet-text-strong">Throwaway round key</span> —
          fresh secp256k1 identity per attempt (not your chat key)
        </li>
        <li>
          <span className="wallet-text-strong">Pedersen + blind Schnorr</span> —
          CashFusion credential math
        </li>
        <li>
          <span className="wallet-text-strong">Output onion</span> — peers peel
          + shuffle outputs (not the same as Tor)
        </li>
      </ul>
      <p className="pt-0.5">
        Compatible wallets that speak the same Nostr pool tags and round
        messages can fuse together — liquidity grows as more wallets adopt
        this P2P protocol (not only OPTN).
      </p>
    </div>
    <p className="text-[10px] leading-relaxed wallet-muted">
      No server: peers meet on Nostr over Tor, elect a coordinator, and run the
      CoinJoin peer-to-peer. Outputs use throwaway keys + mandatory peel-onion
      among peers. You sign only your own inputs after verifying your outputs —
      a hostile coordinator cannot make you sign away funds.
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
      aria-busy={busy}
      className="w-full rounded-xl border border-violet-400/40 px-3 py-2 text-xs font-semibold text-violet-400 hover:bg-violet-400/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:grayscale"
    >
      {busy ? 'Fusing…' : 'Start P2P round'}
    </button>

    {disabled || busy ? (
      <p className="text-center text-[9px] wallet-muted">
        {disabledReason ??
          (busy
            ? 'Round in progress — button stays disabled until it finishes.'
            : 'Requires Tor and ≥3 peers in the same amount tier.')}
      </p>
    ) : (
      <p className="text-center text-[9px] wallet-muted">
        Requires Tor and ≥3 peers in the same amount tier. Leave Auto on — it
        retries after send, receive, or any UTXO change that leaves coins below
        rounds-per-coin. Manual Start joins peers already in the pool.
      </p>
    )}

    {status && (
      <p className="break-all text-center text-[10px] leading-relaxed wallet-muted">{status}</p>
    )}
  </div>
);
