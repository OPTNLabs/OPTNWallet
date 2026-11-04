import React from 'react';

type FriendlyErrorPanelProps = {
  message: string;
  title: string;
  action?: React.ReactNode;
  className?: string;
};

export default function FriendlyErrorPanel({
  message,
  title,
  action,
  className = '',
}: FriendlyErrorPanelProps) {
  return (
    <div
      role="alert"
      className={`rounded-2xl border border-[var(--wallet-danger-border)] bg-[var(--wallet-danger-bg)] p-3 text-sm text-[var(--wallet-danger-text)] ${className}`.trim()}
    >
      <div className="font-semibold">{title}</div>
      <div className="mt-1">{message}</div>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
