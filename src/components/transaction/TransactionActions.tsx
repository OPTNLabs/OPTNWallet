// src/components/transaction/TransactionActions.tsx

import React, { useState } from 'react';
import Popup from './Popup';
import Draggable from 'react-draggable';
import { TransactionOutput, UTXO } from '../../types/types';

interface TransactionActionsProps {
  loading: boolean;
  buildTransaction: () => void;
  sendTransaction: () => void;
  rawTX: string;
  txOutputs: TransactionOutput[];
  selectedUtxos: UTXO[];
  sendingLocked?: boolean;
}

const TransactionActions: React.FC<TransactionActionsProps> = ({
  loading,
  buildTransaction,
  sendTransaction,
  rawTX,
  txOutputs,
  selectedUtxos,
  sendingLocked = false,
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
          <div className="w-8 h-8 border-4 border-t-4 border-[var(--wallet-accent)] rounded-full animate-spin"></div>
        </div>
      )}

      {txOutputs.length > 0 && selectedUtxos.length > 0 && (
        <div className="mb-6">
          <div className="font-bold flex flex-col text-xl">
            {rawTX === ''
              ? '(4) Build Transaction'
              : '(5) Confirm and Send Transaction'}
          </div>
          <div className="flex justify-between mt-4">
            <button
              onClick={buildTransaction}
              disabled={loading || sendingLocked}
              className="wallet-btn-primary font-bold"
              title={
                sendingLocked
                  ? 'Wait for your previous outgoing transaction to sync first'
                  : undefined
              }
            >
              Build TX
            </button>
            {rawTX !== '' && (
              <button
                onClick={handleOpenPopup}
                disabled={loading || sendingLocked}
                className="wallet-btn-danger font-bold"
                title={
                  sendingLocked
                    ? 'Wait for your previous outgoing transaction to sync first'
                    : undefined
                }
              >
                Send TX
              </button>
            )}
          </div>
        </div>
      )}

      {/* Popup with Warning and Swipe Confirmation */}
      {isPopupOpen && (
        <Popup closePopups={handleClose} closeButtonText="Back">
          <div className="flex flex-col items-center p-4">
            <h2 className="text-2xl font-bold mb-4">Confirm Transaction</h2>
            <p className="font-bold text-xl mb-6 text-center wallet-danger-text">
              ⚠️ Warning
            </p>
            <p className="font-semibold text-sm text-center mb-6 wallet-danger-text">
              You are about to <strong>send</strong> a transaction. Please
              confirm that all details are correct. This action{' '}
              <strong>cannot</strong> be undone.
            </p>
            <div className="relative w-[200px] h-12 wallet-surface-strong rounded-lg overflow-hidden border border-[var(--wallet-border)]">
              {/* Background fill for visual feedback */}
              <div
                className={`absolute top-0 left-0 h-full transition-all duration-300 ${
                  position.x >= threshold
                    ? 'wallet-inline-progress'
                    : position.x > 0
                      ? 'bg-[var(--wallet-accent-soft)]'
                      : 'wallet-danger-fill'
                }`}
                style={{ width: `${position.x}px` }}
              />
              {/* Centered "Drag to Confirm" text */}
              <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold z-10 pointer-events-none">
                Drag to Confirm
              </div>
              {/* Draggable handle */}
              <Draggable
                axis="x" // Restrict dragging to horizontal axis
                position={position}
                onDrag={(e, data) => {
                  void e;
                  !loading && setPosition({ x: data.x, y: 0 });
                }}
                onStop={(e, data) => {
                  void e;
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
                  className={`absolute w-12 h-12 wallet-btn-primary flex items-center justify-center text-center rounded-lg ${
                    loading ? 'opacity-50 cursor-not-allowed' : 'cursor-grab'
                  }`}
                >
                  {position.x >= threshold ? '✅' : '➔'}
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
