// src/components/transaction/Popup.tsx

import React from 'react';

interface PopupProps {
  closePopups: () => void;
  children: React.ReactNode;
  closeButtonText?: string; // Optional prop for close button text
}

const Popup: React.FC<PopupProps> = ({
  closePopups,
  children,
  closeButtonText = 'Close',
}) => {
  return (
    <div className="wallet-popup-backdrop z-[1200] p-3 sm:p-4">
      <div
        className="wallet-popup-panel flex w-full max-w-md flex-col"
        style={{
          maxHeight:
            'calc(100dvh - var(--navbar-height) - var(--safe-bottom) - 0.75rem)',
        }}
      >
        <div className="min-h-0 overflow-y-auto pr-1">{children}</div>
        <div
          className="flex justify-center mt-4 pt-3 shrink-0"
          style={{ borderTop: '1px solid var(--wallet-border)' }}
        >
          <button className="wallet-btn-danger w-full my-2" onClick={closePopups}>
            {closeButtonText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Popup;
