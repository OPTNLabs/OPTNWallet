import React from 'react';

type WalletScreenProps = {
  children: React.ReactNode;
  className?: string;
  maxWidthClassName?: string;
  scrollClassName?: string;
  scrollable?: boolean;
  /** Fit an already-constrained parent instead of sizing to the viewport. */
  fitParent?: boolean;
  /** Keep scrollable content above the fixed bottom navigation bar. */
  reserveBottomNavSpace?: boolean;
};

const WalletScreen: React.FC<WalletScreenProps> = ({
  children,
  className = '',
  maxWidthClassName = 'max-w-md',
  scrollClassName = '',
  scrollable = true,
  fitParent = false,
  reserveBottomNavSpace = false,
}) => {
  const heightClassName = fitParent
    ? 'h-full min-h-0'
    : 'h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))]';
  const bottomPaddingClassName = reserveBottomNavSpace
    ? 'pb-[calc(var(--navbar-height)+var(--safe-bottom)+1rem)]'
    : 'pb-[calc(var(--safe-bottom)+1rem)]';

  return (
    <div
      className={`container mx-auto ${maxWidthClassName} ${heightClassName} px-4 pt-4 ${bottomPaddingClassName} flex flex-col overflow-hidden wallet-page ${className}`.trim()}
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
