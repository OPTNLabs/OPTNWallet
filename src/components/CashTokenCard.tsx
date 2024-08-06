// @ts-nocheck
import React from 'react';
import { FaBitcoin } from 'react-icons/fa'; // Example icon, replace with actual icons if needed

const CashTokenCard = ({ category, totalAmount }) => {
  const shortenTxHash = (txHash) => {
    if (!txHash) return '';
    return `${txHash.slice(0, 5)}**********${txHash.slice(-5)}`;
  };

  return (
    <div className="p-4 mb-4 border rounded-lg shadow-md bg-white overflow-hidden">
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
  );
};

export default CashTokenCard;
