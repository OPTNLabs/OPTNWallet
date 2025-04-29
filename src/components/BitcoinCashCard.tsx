// src/components/BitcoinCashCard.tsx
import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import { FaBitcoin } from 'react-icons/fa';

interface Props {
  totalAmount: number; // in satoshis
}

enum DisplayMode {
  BCH = 'BCH',
  USD = 'USD',
}

const BitcoinCashCard: React.FC<Props> = ({ totalAmount }) => {
  // grab the BCH→USD rate (string | null)
  const bchRate = useSelector((state: RootState) => state.priceFeed['BCH']);

  const [mode, setMode] = useState<DisplayMode>(DisplayMode.USD);

  // conversions
  const totalBch = totalAmount / 1e8;

  // parse the rate, fall back to 0 if it's null or not a finite number
  const rateNum = parseFloat(bchRate ?? '');
  const safeRate = Number.isFinite(rateNum) ? rateNum : 0;

  // always a string like "123.45"
  const totalUsd = (totalBch * safeRate).toFixed(2);

  // render
  return (
    <div className="p-4 mb-4 border rounded-lg shadow-md bg-white flex flex-col w-full max-w-md">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <FaBitcoin className="text-green-500 text-3xl" />
          {mode === DisplayMode.BCH ? (
            <div>
              <div className="text-lg font-bold">${totalUsd} USD</div>
              <div className="text-sm text-gray-600">
                {totalBch.toFixed(8)} BCH
              </div>
            </div>
          ) : (
            <div>
              <div className="text-lg font-bold">{totalBch.toFixed(8)} BCH</div>
              <div className="text-sm text-gray-600">${totalUsd} USD</div>
            </div>
          )}
        </div>

        <div className="flex flex-col justify-center mx-4 space-y-2">
          {mode !== DisplayMode.BCH && (
            <button
              onClick={() => setMode(DisplayMode.BCH)}
              className="p-1 px-3 rounded text-white bg-green-500 font-bold hover:bg-green-600 transition duration-200"
            >
              BCH
            </button>
          )}
          {mode !== DisplayMode.USD && (
            <button
              onClick={() => setMode(DisplayMode.USD)}
              className="p-1 px-3 rounded text-white bg-gray-500 font-bold hover:bg-gray-600 transition duration-200"
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
