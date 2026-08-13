// Local-only Stealth BCH marker for coins received via a paycode.
// Matches FusionBadge chip style so coin control / review stay consistent.

import React from 'react';

type StealthBadgeProps = {
  className?: string;
};

export function StealthBadge({
  className = '',
}: StealthBadgeProps): React.ReactElement {
  return (
    <span
      className={
        `inline-block align-middle text-[10px] font-semibold ` +
        `bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded ` +
        className
      }
      title="This coin was received on a reusable payment address (Stealth BCH). Local wallet record only."
    >
      Stealth
    </span>
  );
}

export default StealthBadge;
