import React from 'react';

type PageHeaderProps = {
  title: string;
  subtitle?: string;
  compact?: boolean;
  titleAction?: React.ReactNode;
};

const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  compact = false,
  titleAction,
}) => {
  return (
    <header className={`w-full ${compact ? 'mb-3' : 'mb-4'}`}>
      <div
        className={`grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 ${compact ? 'mt-1 mb-2' : 'mt-2 mb-3'}`}
      >
        <div className="min-w-0">
          <h1
            className="truncate text-left text-lg font-bold tracking-[-0.02em] wallet-text-strong"
            title={title}
          >
            {title}
          </h1>
        </div>
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="OPTN"
          className={`wallet-page-header-logo ${compact ? 'w-32 sm:w-44' : 'w-44 sm:w-56'} h-auto opacity-95`}
        />
        <div className="flex min-w-0 flex-col items-end gap-1 text-right">
          {subtitle ? (
            <p
              className="max-w-full truncate text-xs wallet-muted"
              title={subtitle}
            >
              {subtitle}
            </p>
          ) : null}
          {titleAction}
        </div>
      </div>
    </header>
  );
};

export default PageHeader;
