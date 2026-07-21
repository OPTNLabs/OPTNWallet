import React from 'react';

// The P2P CashFusion panel inside the CashFusion settings card. Presentational:
// the parent (CashFusionSettings) owns Tor resolution + the runP2pFusion call and
// passes the start handler + live status down. On chipnet this runs a real round;
// on mainnet it stays gated (disabled) behind the wallet-safety guarantees.
interface P2pFusionPanelProps {
  onStart: () => void;
  status: string | null;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
}

export const P2pFusionTransportPreview: React.FC<P2pFusionPanelProps> = ({
  onStart,
  status,
  busy,
  disabled,
  disabledReason,
}) => (
  <div className="space-y-2.5 rounded-xl border border-violet-400/20 bg-violet-400/5 p-3">
    <div className="flex items-center gap-2">
      <p className="text-xs font-semibold text-violet-400">P2P Fusion over Nostr</p>
      <span className="rounded-full border border-violet-400/30 bg-violet-400/10 px-2 py-0.5 text-[9px] font-bold uppercase text-violet-400">
        Experimental
      </span>
    </div>
    <p className="text-[10px] leading-relaxed wallet-muted">
      No server: peers meet on Nostr relays over Tor, deterministically elect a
      coordinator, and run the CoinJoin peer-to-peer. Outputs are unlinkable
      (throwaway keys + Tor); you sign only your own inputs, and only after
      verifying your own outputs are present — a hostile coordinator can never make
      you sign away funds.
    </p>

    <button
      type="button"
      onClick={onStart}
      disabled={disabled || busy}
      className="w-full rounded-xl border border-violet-400/40 px-3 py-2 text-xs font-semibold text-violet-400 hover:bg-violet-400/5 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? 'Running P2P round…' : 'Start P2P round'}
    </button>

    {disabled && disabledReason ? (
      <p className="text-center text-[9px] wallet-muted">{disabledReason}</p>
    ) : (
      <p className="text-center text-[9px] wallet-muted">
        Requires Tor + at least 2 peers in the same tier. Chipnet test path.
      </p>
    )}

    {status && (
      <p className="break-all text-center text-[10px] leading-relaxed wallet-muted">{status}</p>
    )}
  </div>
);
