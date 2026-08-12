import React, { useState } from 'react';
import { FaBitcoin } from 'react-icons/fa';
import { shortenTxHash } from '../utils/shortenHash';
import TokenQuery from './TokenQuery';
import useSharedTokenMetadata from '../hooks/useSharedTokenMetadata';

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
  const iconUri = metadata?.iconUri ?? null;
  const tokenName = metadata?.name || shortenTxHash(category);
  const bcmrSnapshot = metadata?.snapshot ?? null;

  const toggleTokenQueryPopup = () => setShowTokenQuery(!showTokenQuery);

  const formatAmountWithDecimals = (amount: bigint, decimalPlaces: number): string => {
    if (decimalPlaces <= 0) return amount.toString();
    const amountStr = amount.toString();
    const padded = amountStr.padStart(decimalPlaces + 1, '0');
    const integerPart = padded.slice(0, -decimalPlaces) || '0';
    const fractionalPart = padded.slice(-decimalPlaces).replace(/0+$/, '');
    return fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
  };

  const rawAmount = totalAmount.toString();
  const effectiveDecimals =
    typeof metadata?.decimals === 'number'
      ? metadata.decimals
      : decimals;
  const displayAmount =
    effectiveDecimals > 0
      ? formatAmountWithDecimals(totalAmount, effectiveDecimals)
      : rawAmount;

  return (
    <>
      {/* Card */}
      <div
        className="wallet-card p-4 mb-4 flex items-center justify-between cursor-pointer hover:brightness-[0.98]"
        onClick={toggleTokenQueryPopup}
      >
        <div className="flex items-center space-x-3 overflow-hidden">
          {/* icon */}
          <div className="w-8 h-8 wallet-surface-strong rounded flex items-center justify-center flex-shrink-0">
            {iconUri ? (
              <img
                src={iconUri}
                alt={tokenName}
                className="w-full h-full rounded"
              />
            ) : (
              <FaBitcoin className="wallet-accent-icon text-xl" />
            )}
          </div>
          <div className="flex flex-col truncate">
            <span className="text-base font-semibold truncate">
              {tokenName}
            </span>
            <span className="text-xs wallet-muted truncate">
              {shortenTxHash(category)}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-medium wallet-text-strong">{displayAmount}</div>
        </div>
      </div>

      {/* Bottom-sheet */}
      {showTokenQuery && (
        <div className="wallet-popup-backdrop z-50 flex justify-end">
          <div className="wallet-popup-panel w-full rounded-t-xl p-4 max-h-[85vh] overflow-y-auto shadow-xl">
            <div className="text-center text-lg font-bold mb-4">
              {tokenName} Details
            </div>
            <div className="overflow-y-auto flex-grow mb-4">
              <TokenQuery
                tokenId={category}
                prefetchedSnapshot={bcmrSnapshot}
                prefetchedIconDataUri={iconUri}
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
