import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  selectRpaEnabled,
  selectCashFusionEnabled,
  selectQuantumrootEnabled,
  setRpaEnabled,
  setCashFusionEnabled,
  setQuantumrootEnabled,
} from '../../state/slices/experimentalSlice';

type FeatureToggleProps = {
  title: string;
  badge?: string;
  description: string;
  warning?: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
};

function FeatureToggle({ title, badge, description, warning, enabled, onToggle }: FeatureToggleProps) {
  return (
    <div className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold wallet-text-strong truncate">{title}</span>
          {badge && (
            <span className="shrink-0 rounded-full border border-yellow-400/40 bg-yellow-400/10 px-2 py-0.5 text-[10px] font-bold text-yellow-400 uppercase tracking-wide">
              {badge}
            </span>
          )}
        </div>
        <button
          onClick={() => onToggle(!enabled)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
            enabled
              ? 'bg-[var(--wallet-accent)] border-[var(--wallet-accent)]'
              : 'wallet-surface-strong border-[var(--wallet-border)]'
          }`}
          aria-label={`${enabled ? 'Disable' : 'Enable'} ${title}`}
        >
          <span
            className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
              enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
      <p className="text-xs wallet-muted leading-relaxed">{description}</p>
      {warning && (
        <p className="text-xs text-yellow-400/90 leading-relaxed">⚠ {warning}</p>
      )}
    </div>
  );
}

export const ExperimentalSettings: React.FC = () => {
  const dispatch = useDispatch();
  const rpaEnabled = useSelector(selectRpaEnabled);
  const cashFusionEnabled = useSelector(selectCashFusionEnabled);
  const quantumrootEnabled = useSelector(selectQuantumrootEnabled);

  return (
    <div className="flex flex-col gap-4">

      <div className="rounded-xl border border-yellow-400/20 bg-yellow-400/5 p-3 space-y-1">
        <p className="text-xs font-semibold text-yellow-400">Experimental Features</p>
        <p className="text-xs wallet-muted leading-relaxed">
          These features are under active development. Enable them to test new capabilities
          — they may change or be incomplete in future updates.
        </p>
      </div>

      <FeatureToggle
        title="Quantumroot"
        badge="Quantum-safe"
        description="Quantumroot vaults protect funds with a quantum-resistant Schnorr LM-OTS scheme. Enabled by default. Turn off to hide Quantumroot from the wallet if you don't use it."
        enabled={quantumrootEnabled}
        onToggle={(v) => dispatch(setQuantumrootEnabled(v))}
      />

      <FeatureToggle
        title="Reusable Payment Addresses (RPA)"
        badge="BCH RPA"
        description="Generates a static paycode (paycode:q...) that you can share publicly. Senders derive a unique one-time address for each payment via ECDH — no notification transaction, no chain bloat. Received stealth funds appear separately as 'Stealth BCH'. Scanning requires a Fulcrum-RPA capable server."
        warning="Sending to paycodes requires signature grinding (not yet implemented). Receiving and scanning are available."
        enabled={rpaEnabled}
        onToggle={(v) => dispatch(setRpaEnabled(v))}
      />

      <FeatureToggle
        title="CashFusion"
        badge="Privacy"
        description="CashFusion is a non-custodial privacy protocol that combines your UTXOs with those of other users in a way that breaks transaction history linkage. Connect to a CashFusion server to participate. Your funds are never at risk — the protocol is trustless."
        warning="Requires an active CashFusion server connection. Coming soon — toggle currently reserved."
        enabled={cashFusionEnabled}
        onToggle={(v) => dispatch(setCashFusionEnabled(v))}
      />

    </div>
  );
};
