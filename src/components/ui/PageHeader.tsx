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
      <div className={`flex justify-center ${compact ? 'mt-1 mb-2' : 'mt-2 mb-3'}`}>
        <img
          src="/assets/images/OPTNWelcome1.png"
          alt="OPTN"
          className={`${compact ? 'w-1/2' : 'w-3/4'} h-auto opacity-95`}
        />
      </div>
      <div className="text-center">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div aria-hidden="true" />
          <h1 className="text-2xl font-bold wallet-text-strong tracking-[-0.02em] justify-self-center">
            {title}
          </h1>
          <div className="justify-self-end">{titleAction}</div>
        </div>
        {subtitle ? (
          <p className="mt-1 text-center text-sm wallet-muted">{subtitle}</p>
        ) : null}
      </div>
    </header>
  );
};

export default PageHeader;
