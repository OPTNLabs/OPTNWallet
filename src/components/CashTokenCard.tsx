import { useState } from 'react';
import { FaBitcoin } from 'react-icons/fa';
import { shortenTxHash } from '../utils/shortenHash';
import TokenQuery from './TokenQuery';

const CashTokenCard = ({ category, totalAmount }) => {
  const [showTokenQuery, setShowTokenQuery] = useState(false);

  const toggleTokenQueryPopup = () => {
    setShowTokenQuery(!showTokenQuery);
  };

  return (
    <>
      <div
        className="p-4 mb-4 border rounded-lg shadow-md bg-white overflow-hidden cursor-pointer hover:bg-gray-100"
        onClick={toggleTokenQueryPopup}
      >
        <div className="flex items-center">
          <FaBitcoin className="mr-2 text-blue-500" /> {/* Example icon */}
          <p className="text-sm break-words font-bold">
            {shortenTxHash(category)}
          </p>
        </div>
        <p className="text-sm break-words">
          <strong>CashToken Amount:</strong> {totalAmount}
        </p>
      </div>

      {showTokenQuery && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 flex justify-center items-center">
          <div className="relative top-20 mx-auto p-5 w-3/4 max-w-3xl bg-white rounded-md shadow-lg flex flex-col">
            <div className="text-center text-lg font-bold mb-4">
              Token Details
            </div>
            <div className="overflow-y-auto flex-grow mb-4">
              <TokenQuery tokenId={category} />
            </div>
            <button
              className="w-full bg-red-500 text-white rounded hover:bg-red-600"
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
