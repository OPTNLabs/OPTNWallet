import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import { FaBitcoin } from 'react-icons/fa';

interface BitcoinCashCardProps {
  totalAmount: number; // in satoshis
  togglePopup: () => void; // Add a togglePopup prop
}

enum DisplayMode {
  BCH = 'BCH',
  USD = 'USD',
}

const BitcoinCashCard: React.FC<BitcoinCashCardProps> = ({
  totalAmount,
  togglePopup,
}) => {
  // Get the BCH price from Redux
  const bchPriceUsd = useSelector(
    (state: RootState) => state.priceFeed['bitcoin-cash']?.priceUsd
  );

  // State for display mode
  const [displayMode, setDisplayMode] = useState<DisplayMode>(DisplayMode.BCH);

  // Calculate the total in BCH (1 BCH = 100,000,000 satoshis)
  const totalBch = totalAmount / 100000000;

  // Calculate the total value in USD
  const totalUsd = bchPriceUsd
    ? (totalBch * parseFloat(bchPriceUsd)).toFixed(2)
    : null;

  // Render content based on the selected display mode
  const renderAmount = () => {
    switch (displayMode) {
      case DisplayMode.BCH:
        return (
          <>
            <div className="text-lg font-bold">{totalBch.toFixed(8)} BCH</div>
            {totalUsd && (
              <div className="text-sm text-gray-600">${totalUsd} USD</div>
            )}
          </>
        );
      case DisplayMode.USD:
        return (
          <>
            {totalUsd && (
              <div className="text-lg font-bold">${totalUsd} USD</div>
            )}
            <div className="text-sm text-gray-600">
              {totalBch.toFixed(8)} BCH
            </div>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <div className="p-4 mb-4 border rounded-lg shadow-md bg-white flex flex-col w-full max-w-md">
      <div className="flex items-center justify-between">
        {/* Only this section triggers the togglePopup */}
        <div className="flex items-center cursor-pointer" onClick={togglePopup}>
          <FaBitcoin className="text-green-500 text-3xl mr-3" />
          <div>{renderAmount()}</div>
        </div>
        {/* Toggle buttons */}
        <div className="flex flex-col justify-center mx-4 space-y-2">
          {/* Toggle BCH/USD button */}
          {displayMode !== DisplayMode.BCH && (
            <button
              onClick={() => setDisplayMode(DisplayMode.BCH)}
              className="p-1 px-3 rounded bg-gray-300 hover:bg-green-500 hover:text-white transition duration-200"
            >
              BCH
            </button>
          )}
          {displayMode !== DisplayMode.USD && (
            <button
              onClick={() => setDisplayMode(DisplayMode.USD)}
              className="p-1 px-3 rounded bg-gray-300 hover:bg-green-500 hover:text-white transition duration-200"
            >
              USD
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default BitcoinCashCard;
