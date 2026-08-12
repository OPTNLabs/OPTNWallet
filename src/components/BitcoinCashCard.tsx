// src/components/BitcoinCashCard.tsx
import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import { FaBitcoin } from 'react-icons/fa';
import { SATSINBITCOIN } from '../utils/constants';

interface Props {
  totalAmount: number; // in satoshis
}

enum DisplayMode {
  BCH = 'BCH',
  USD = 'USD',
}

const BitcoinCashCard: React.FC<Props> = ({ totalAmount }) => {
  // New state shape: key is 'BCH-USD' → { price, ts, source }
  const bchQuote = useSelector(
    (state: RootState) => state.priceFeed['BCH-USD']
  );

  const [mode, setMode] = useState<DisplayMode>(DisplayMode.USD);

  // conversions
  const totalBch = totalAmount / SATSINBITCOIN;

  // use numeric price, fall back to 0 if undefined
  const safeRate = bchQuote?.price ?? 0;
  const totalUsd = (totalBch * safeRate).toFixed(2);

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

      {/* tiny status footer */}
      {/* <div className="mt-2 text-xs text-gray-400">
        {bchQuote
          ? `Source: ${bchQuote.source} • Updated ${Math.max(
              0,
              Math.floor((Date.now() - bchQuote.ts) / 1000)
            )}s ago`
          : 'Fetching BCH price…'}
      </div> */}
    </div>
  );
};

export default BitcoinCashCard;
