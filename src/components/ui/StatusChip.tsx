import React from 'react';

type StatusTone = 'success' | 'warning' | 'neutral';

type StatusChipProps = {
  tone?: StatusTone;
  children: React.ReactNode;
};

const toneClass: Record<StatusTone, string> = {
  success: 'wallet-success-panel',
  warning: 'wallet-warning-panel',
  neutral: 'wallet-surface-strong border border-[var(--wallet-border)] wallet-text-strong',
};

const StatusChip: React.FC<StatusChipProps> = ({ tone = 'neutral', children }) => {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${toneClass[tone]}`}>
      {children}
    </span>
  );
};

export default StatusChip;
