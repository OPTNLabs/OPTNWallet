import React, { useState } from 'react';
import TokenQuery from './TokenQuery';
import useSharedTokenMetadata from '../hooks/useSharedTokenMetadata';
import TokenIdentityBadge from './ui/TokenIdentityBadge';
import {
  formatAtomicTokenAmount,
  resolveTokenPresentation,
} from '../utils/tokenPresentation';

interface CashTokenCardProps {
  category: string;
  totalAmount: bigint;
  decimals: number;
}

const CashTokenCard: React.FC<CashTokenCardProps> = ({
  category,
  totalAmount,
  decimals,
}) => {
  const [showTokenQuery, setShowTokenQuery] = useState(false);
  const metadata = useSharedTokenMetadata([category])[category];
  const presentation = resolveTokenPresentation(category, metadata);
  const bcmrSnapshot = metadata?.snapshot ?? null;

  const toggleTokenQueryPopup = () => setShowTokenQuery(!showTokenQuery);

  const displayAmount = formatAtomicTokenAmount(
    totalAmount,
    presentation.decimals ?? decimals
  );

  return (
    <>
      {/* Card */}
      <div
        className="wallet-card p-4 mb-4 flex items-center justify-between cursor-pointer hover:brightness-[0.98]"
        onClick={toggleTokenQueryPopup}
      >
        <TokenIdentityBadge
          presentation={presentation}
          className="min-w-0 flex-1"
          avatarClassName="h-8 w-8"
          primaryClassName="text-sm"
          secondaryClassName="text-[11px]"
        />
        <div className="text-right">
          <div className="text-sm font-medium wallet-text-strong">{displayAmount}</div>
        </div>
      </div>

      {/* Bottom-sheet */}
      {showTokenQuery && (
        <div className="wallet-popup-backdrop z-50 flex justify-end">
          <div className="wallet-popup-panel w-full rounded-t-xl p-4 max-h-[85vh] overflow-y-auto shadow-xl">
            <div className="text-center text-lg font-bold mb-4">
              {presentation.primaryLabel} Details
            </div>
            <div className="overflow-y-auto flex-grow mb-4">
              <TokenQuery
                tokenId={category}
                prefetchedSnapshot={bcmrSnapshot}
                prefetchedIconDataUri={presentation.iconUri}
              />
            </div>
            <button
              className="wallet-btn-secondary mt-2 w-full py-3"
              onClick={toggleTokenQueryPopup}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default CashTokenCard;
