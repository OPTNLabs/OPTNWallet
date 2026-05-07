import React from 'react';

type WalletScreenProps = {
  children: React.ReactNode;
  className?: string;
  maxWidthClassName?: string;
  scrollClassName?: string;
  scrollable?: boolean;
};

const WalletScreen: React.FC<WalletScreenProps> = ({
  children,
  className = '',
  maxWidthClassName = 'max-w-md',
  scrollClassName = '',
  scrollable = true,
}) => {
  return (
    <div
      className={`container mx-auto ${maxWidthClassName} h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] px-4 pt-4 pb-[calc(var(--safe-bottom)+1rem)] flex flex-col overflow-hidden wallet-page ${className}`.trim()}
    >
      <div
        className={`flex-1 min-h-0 overflow-x-hidden pr-1 ${scrollable ? 'overflow-y-auto overscroll-contain touch-pan-y' : 'overflow-hidden'} ${scrollClassName}`.trim()}
      >
        {children}
      </div>
    </div>
  );
};

export default WalletScreen;
