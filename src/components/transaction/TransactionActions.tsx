// @ts-nocheck

// src/components/transaction/TransactionActions.tsx

import React, { useState } from 'react';
import Popup from './Popup';
import Draggable from 'react-draggable';

interface TransactionActionsProps {
  loading: boolean;
  buildTransaction: () => void;
  sendTransaction: () => void;
  rawTX: string;
}

const TransactionActions: React.FC<TransactionActionsProps> = ({
  loading,
  buildTransaction,
  sendTransaction,
  rawTX,
}) => {
  const [isPopupOpen, setIsPopupOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Slider constants
  const sliderWidth = 200; // Track width in pixels
  const handleWidth = 48; // Handle width in pixels (matches Tailwind's w-12, ~3rem)
  const threshold = sliderWidth * 0.7; // Confirmation threshold at 80% (160px)

  // Function to open the popup
  const handleOpenPopup = () => {
    setIsPopupOpen(true);
  };

  // Function to close the popup and reset position
  const handleClose = () => {
    setIsPopupOpen(false);
    setPosition({ x: 0, y: 0 });
  };

  return (
    <div>
      {/* Spinning Loader */}
      {loading && (
        <div className="flex justify-center items-center mb-6">
          <div className="w-8 h-8 border-4 border-t-4 border-blue-500 rounded-full animate-spin"></div>
        </div>
      )}

      {/* Button Container with Flex Layout */}
      <div className="flex justify-between mb-6">
        <button
          onClick={buildTransaction}
          disabled={loading}
          className={`bg-green-500 font-bold text-white py-2 px-4 rounded ${
            loading ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        >
          Build TX
        </button>
        {rawTX.length > 0 && (
          <button
            onClick={handleOpenPopup}
            disabled={loading}
            className={`bg-red-500 font-bold text-white py-2 px-4 rounded ${
              loading ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            Send TX
          </button>
        )}
      </div>

      {/* Popup with Warning and Swipe Confirmation */}
      {isPopupOpen && (
        <Popup closePopups={handleClose} closeButtonText="Back">
          <div className="flex flex-col items-center p-4">
            <h2 className="text-2xl font-bold mb-4">Confirm Transaction</h2>
            <p className="text-red-600 font-bold text-xl mb-6 text-center">
              ⚠️ Warning
            </p>
            <p className="text-red-600 font-semibold text-sm text-center mb-6">
              You are about to send a transaction. Please confirm that all
              details are correct. This action cannot be undone.
            </p>
            <div className="relative w-[200px] h-12 bg-gray-200 rounded-lg overflow-hidden">
              {/* Background fill for visual feedback */}
              <div
                className={`absolute top-0 left-0 h-full transition-all duration-300 ${
                  position.x >= threshold
                    ? 'bg-green-500'
                    : position.x > 0
                      ? 'bg-orange-500'
                      : 'bg-red-500'
                }`}
                style={{ width: `${position.x}px` }}
              ></div>
              {/* Draggable handle */}
              <Draggable
                axis="x" // Restrict dragging to horizontal axis
                position={position}
                onDrag={(e, data) =>
                  !loading && setPosition({ x: data.x, y: 0 })
                }
                onStop={(e, data) => {
                  if (data.x >= threshold && !loading) {
                    sendTransaction();
                  } else {
                    setPosition({ x: 0, y: 0 }); // Snap back if threshold not met
                  }
                }}
                bounds={{ left: 0, right: sliderWidth - handleWidth }} // Keep handle within track
                disabled={loading} // Disable dragging when loading
              >
                <div
                  className={`absolute w-12 h-12 bg-blue-500 text-white flex items-center justify-center text-center rounded-lg ${
                    loading ? 'opacity-50 cursor-not-allowed' : 'cursor-grab'
                  }`}
                >
                  {position.x >= threshold ? '✅' : 'Send TX'}
                </div>
              </Draggable>
            </div>
          </div>
        </Popup>
      )}
    </div>
  );
};

export default TransactionActions;
