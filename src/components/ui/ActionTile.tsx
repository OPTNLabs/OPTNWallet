import React from 'react';

type ActionTileProps = {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  compact?: boolean;
  layout?: 'stacked' | 'horizontal';
};

const ActionTile: React.FC<ActionTileProps> = ({
  title,
  description,
  icon,
  onClick,
  disabled = false,
  className = '',
  compact = false,
  layout = 'stacked',
}) => {
  const classes = `wallet-card ${compact ? 'p-3' : 'p-4'} text-left transition ${
    disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:brightness-[0.98]'
  } ${className}`.trim();

  const content = (
    layout === 'horizontal' ? (
      <div className="flex items-center gap-3">
        {icon ? (
          <div
            className={`flex shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_70%,transparent)] text-[var(--wallet-accent-strong)] ${
              compact ? 'h-8 w-8 text-[1.1rem]' : 'h-11 w-11 text-[1.35rem]'
            }`}
          >
            {icon}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className={`${compact ? 'text-sm' : 'font-semibold'} wallet-text-strong`}>
            {title}
          </div>
          {description ? (
            <div className={`${compact ? 'text-xs' : 'text-sm'} wallet-muted`}>
              {description}
            </div>
          ) : null}
        </div>
      </div>
    ) : (
      <>
        {icon ? (
          <div
            className={`flex items-center justify-center rounded-2xl bg-[color-mix(in_oklab,var(--wallet-accent-soft)_70%,transparent)] text-[var(--wallet-accent-strong)] ${
              compact ? 'mb-2 h-8 w-8 text-[1.1rem]' : 'mb-3 h-11 w-11 text-[1.35rem]'
            }`}
          >
            {icon}
          </div>
        ) : null}
        <div className={`${compact ? 'text-sm' : 'font-semibold'} wallet-text-strong`}>
          {title}
        </div>
        {description ? (
          <div className={`${compact ? 'mt-0.5 text-xs' : 'mt-1 text-sm'} wallet-muted`}>
            {description}
          </div>
        ) : null}
      </>
    )
  );

  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick} disabled={disabled}>
        {content}
      </button>
    );
  }

  return <div className={classes}>{content}</div>;
};

export default ActionTile;
