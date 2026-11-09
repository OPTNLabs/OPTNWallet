import React from 'react';

type RouteExitFooterProps = {
  label: string;
  onBack: () => void;
  disabled?: boolean;
};

/** Shared route-exit affordance for Actions and Apps destination screens. */
const RouteExitFooter: React.FC<RouteExitFooterProps> = ({
  label,
  onBack,
  disabled = false,
}) => (
  <div className="mt-auto shrink-0 border-t border-[var(--wallet-border)] pt-3 pb-2">
    <button
      type="button"
      className="wallet-btn-danger w-full py-3 font-semibold"
      onClick={onBack}
      disabled={disabled}
      data-testid="route-exit-back"
    >
      {label}
    </button>
  </div>
);

export default RouteExitFooter;
