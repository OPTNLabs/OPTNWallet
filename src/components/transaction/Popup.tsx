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
    <div className="wallet-popup-backdrop">
      <div className="wallet-popup-panel">
        {children}
        <div className="flex justify-center mt-4">
          <button className="wallet-btn-danger w-full my-2" onClick={closePopups}>
            {closeButtonText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Popup;
