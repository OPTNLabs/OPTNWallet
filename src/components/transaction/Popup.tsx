// src/components/transaction/Popup.tsx

import React from 'react';

interface PopupProps {
  closePopups: () => void;
  children: React.ReactNode;
  closeButtonText?: string; // Optional prop for close button text
}

const Popup: React.FC<PopupProps> = ({ closePopups, children, closeButtonText = 'Close' }) => {
  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center">
      <div className="bg-white p-6 rounded shadow-lg w-full max-w-md max-h-[90vh] overflow-hidden">
        {children}
        <div className="flex justify-center mt-4">
          <button
            className="w-full bg-red-500 font-bold text-white py-2 px-4 rounded-md hover:bg-red-600 transition duration-300 my-2"
            onClick={closePopups}
          >
            {closeButtonText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Popup;