import React from 'react';

type SectionHeaderProps = {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
};

const SectionHeader: React.FC<SectionHeaderProps> = ({
  title,
  subtitle,
  action,
  className = '',
  compact = false,
}) => {
  return (
    <div className={`${compact ? 'mb-2' : 'mb-3'} flex items-end justify-between gap-3 ${className}`.trim()}>
      <div>
        <div className={`${compact ? 'text-sm' : 'text-base'} font-semibold wallet-text-strong`}>
          {title}
        </div>
        {subtitle ? (
          <div className={`${compact ? 'text-[11px]' : 'text-xs'} wallet-muted`}>
            {subtitle}
          </div>
        ) : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  );
};

export default SectionHeader;
