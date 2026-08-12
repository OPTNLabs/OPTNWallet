import React from 'react';

type SettingsRowProps = {
  title: string;
  description?: string;
  onClick?: () => void;
  right?: React.ReactNode;
  disabled?: boolean;
  compact?: boolean;
};

const SettingsRow: React.FC<SettingsRowProps> = ({
  title,
  description,
  onClick,
  right,
  disabled = false,
  compact = false,
}) => {
  const body = (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className={`${compact ? 'text-sm' : 'font-semibold'} wallet-text-strong`}>
          {title}
        </div>
        {description ? (
          <div className={`${compact ? 'text-xs' : 'text-sm'} wallet-muted`}>
            {description}
          </div>
        ) : null}
      </div>
      <div className="shrink-0">{right ?? <span className="wallet-muted">›</span>}</div>
    </div>
  );

  if (onClick || disabled) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`wallet-card w-full text-left transition hover:brightness-[0.98] disabled:cursor-not-allowed disabled:opacity-70 ${
          compact ? 'p-3' : 'p-4'
        }`}
      >
        {body}
      </button>
    );
  }

  return <div className={`wallet-card w-full ${compact ? 'p-3' : 'p-4'}`}>{body}</div>;
};

export default SettingsRow;
