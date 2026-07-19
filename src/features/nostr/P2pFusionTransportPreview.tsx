import React from 'react';

const stages = [
  { label: 'Dedicated transport identity', status: 'Planned' },
  { label: 'NIP-44 encrypted relay rendezvous', status: 'Planned' },
  { label: 'Round replay and sequence protection', status: 'Planned' },
  { label: 'Peer acknowledgements and timeouts', status: 'Planned' },
  { label: 'Wallet signing safety gate', status: 'Blocked safely' },
] as const;

export const P2pFusionTransportPreview: React.FC = () => (
  <div className="space-y-3 rounded-xl border border-violet-400/20 bg-violet-400/5 p-3">
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold text-violet-400">P2P Fusion over Nostr</p>
          <span className="rounded-full border border-violet-400/30 bg-violet-400/10 px-2 py-0.5 text-[9px] font-bold uppercase text-violet-400">
            Phase 4 UI
          </span>
        </div>
        <p className="mt-1 text-[10px] leading-relaxed wallet-muted">
          Peer discovery and encrypted coordination will use Nostr only as a
          transport. The native CashFusion state machine remains authoritative.
        </p>
      </div>
      <span className="shrink-0 rounded-full border border-yellow-400/30 bg-yellow-400/10 px-2 py-1 text-[9px] font-semibold text-yellow-400">
        Offline
      </span>
    </div>

    <div className="space-y-1.5">
      {stages.map((stage, index) => (
        <div key={stage.label} className="flex items-center gap-2 rounded-lg border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-[var(--wallet-border)] text-[9px] font-bold wallet-muted">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 text-[10px] font-medium wallet-text-strong">{stage.label}</span>
          <span className="shrink-0 text-[9px] wallet-muted">{stage.status}</span>
        </div>
      ))}
    </div>

    <button
      type="button"
      disabled
      className="w-full rounded-xl border border-violet-400/35 px-3 py-2 text-xs font-semibold text-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
    >
      Start P2P round · unavailable
    </button>
    <p className="text-center text-[9px] wallet-muted">
      Relay acceptance will never authorize a spend. No round can start in this build.
    </p>
  </div>
);
