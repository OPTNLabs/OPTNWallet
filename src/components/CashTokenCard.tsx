import React, { useState, useEffect } from 'react';
import { FaBitcoin } from 'react-icons/fa';
import { shortenTxHash } from '../utils/shortenHash';
import TokenQuery from './TokenQuery';
import BcmrService from '../services/BcmrService';
import { IdentitySnapshot } from '@bitauth/libauth';

interface CashTokenCardProps {
  category: string;
  totalAmount: number;
}

const CashTokenCard: React.FC<CashTokenCardProps> = ({
  category,
  totalAmount,
}) => {
  const [showTokenQuery, setShowTokenQuery] = useState(false);
  const [iconUri, setIconUri] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState<string>(shortenTxHash(category));

  const toggleTokenQueryPopup = () => setShowTokenQuery(!showTokenQuery);

  useEffect(() => {
    const loadMetadata = async () => {
      try {
        const bcmr = new BcmrService();
        const authbase = await bcmr.getCategoryAuthbase(category);
        const idReg = await bcmr.resolveIdentityRegistry(authbase);
        const snap: IdentitySnapshot = bcmr.extractIdentity(
          authbase,
          idReg.registry
        );
        setTokenName(snap.name);
        const uri = await bcmr.resolveIcon(authbase);
        setIconUri(uri);
      } catch (err) {
        console.error('Failed to load token metadata', err);
      }
    };
    loadMetadata();
  }, [category]);

  return (
    <>
      {/* Card */}
      <div
        className="p-4 mb-4 border rounded-lg shadow-sm bg-white flex items-center justify-between cursor-pointer hover:bg-gray-50"
        onClick={toggleTokenQueryPopup}
      >
        <div className="flex items-center space-x-3 overflow-hidden">
          {/* icon */}
          <div className="w-8 h-8 bg-gray-100 rounded flex items-center justify-center flex-shrink-0">
            {iconUri ? (
              <img
                src={iconUri}
                alt={tokenName}
                className="w-full h-full rounded"
              />
            ) : (
              <FaBitcoin className="text-blue-500 text-xl" />
            )}
          </div>
          <div className="flex flex-col truncate">
            <span className="text-base font-semibold truncate">
              {tokenName}
            </span>
            <span className="text-xs text-gray-500 truncate">
              {shortenTxHash(category)}
            </span>
          </div>
        </div>
        <div className="text-sm font-medium text-gray-700">
          {totalAmount !== 0 ? totalAmount : ''}
        </div>
      </div>

      {/* Bottom-sheet */}
      {showTokenQuery && (
        <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex justify-end">
          <div className="bg-white w-full rounded-t-xl p-4 max-h-[85vh] overflow-y-auto shadow-xl">
            <div className="text-center text-lg font-bold mb-4">
              {tokenName} Details
            </div>
            <div className="overflow-y-auto flex-grow mb-4">
              <TokenQuery tokenId={category} />
            </div>
            <button
              className="mt-2 w-full py-3 bg-gray-200 text-gray-800 rounded-lg font-medium hover:bg-gray-300 transition"
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
