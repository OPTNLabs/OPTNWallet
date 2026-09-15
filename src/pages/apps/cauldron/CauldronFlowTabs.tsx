import type { CSSProperties } from 'react';

export type CauldronFlowMode = 'swap' | 'merchant' | 'pool';

type CauldronFlowTabsProps = {
  activeMode: CauldronFlowMode;
  onChange: (mode: CauldronFlowMode) => void;
};

const baseClass =
  'rounded-2xl px-3 py-2 text-sm font-semibold transition-colors duration-150';

const activeStyle: CSSProperties = {
  background: 'var(--wallet-btn-primary-bg)',
  color: '#ffffff',
  boxShadow: 'var(--wallet-shadow-btn)',
};

const inactiveStyle: CSSProperties = {
  backgroundColor: 'var(--wallet-segment-inactive-bg)',
  color: 'var(--wallet-segment-inactive-text)',
  border: '1px solid var(--wallet-border)',
};

export default function CauldronFlowTabs({
  activeMode,
  onChange,
}: CauldronFlowTabsProps) {
  // Merchant payment is entered from the Merchant Pay app and opened from a
  // scanned request. It is not a second version of the general swap form.
  // Keep the mode in the type because a scanned proposal still needs a
  // distinct execution path, but do not advertise it as a peer tab.
  const modes: Array<{ mode: CauldronFlowMode; label: string }> = [
    { mode: 'swap', label: 'Swap' },
    { mode: 'pool', label: 'Pool' },
  ];

  return (
    <div className="grid grid-cols-2 gap-2">
      {modes.map(({ mode, label }) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={baseClass}
          style={activeMode === mode ? activeStyle : inactiveStyle}
          aria-pressed={activeMode === mode}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
