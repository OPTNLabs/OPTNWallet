import React from 'react';

type ActionTileProps = {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  compact?: boolean;
  layout?: 'stacked' | 'horizontal';
  descriptionLines?: number;
  style?: React.CSSProperties;
};

const ActionTile: React.FC<ActionTileProps> = ({
  title,
  description,
  icon,
  trailing,
  onClick,
  disabled = false,
  className = '',
  compact = false,
  layout = 'stacked',
  descriptionLines,
  style,
}) => {
  const classes = `wallet-card w-full ${compact ? 'p-3' : 'p-4'} text-left transition ${
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
          <div
            className={`${compact ? 'text-sm' : 'font-semibold'} truncate wallet-text-strong`}
          >
            {title}
          </div>
          {description ? (
            <div
              className={`${compact ? 'text-xs' : 'text-sm'} wallet-muted`}
              style={
                descriptionLines
                  ? {
                      display: '-webkit-box',
                      WebkitBoxOrient: 'vertical',
                      WebkitLineClamp: descriptionLines,
                      overflow: 'hidden',
                    }
                  : undefined
              }
            >
              {description}
            </div>
          ) : null}
        </div>
        {trailing ? <div className="shrink-0 self-start">{trailing}</div> : null}
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
        <div className={`${compact ? 'text-sm' : 'font-semibold'} truncate wallet-text-strong`}>
          {title}
        </div>
        {description ? (
          <div
            className={`${compact ? 'mt-0.5 text-xs' : 'mt-1 text-sm'} wallet-muted`}
            style={
              descriptionLines
                ? {
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: descriptionLines,
                    overflow: 'hidden',
                  }
                : undefined
            }
          >
            {description}
          </div>
        ) : null}
        {trailing ? <div className="mt-2">{trailing}</div> : null}
      </>
    )
  );

  if (onClick) {
    return (
      <button type="button" className={classes} style={style} onClick={onClick} disabled={disabled}>
        {content}
      </button>
    );
  }

  return (
    <div className={classes} style={style}>
      {content}
    </div>
  );
};

export default ActionTile;
