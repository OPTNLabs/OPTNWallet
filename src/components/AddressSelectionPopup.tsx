import React, { useState, useEffect } from 'react';
import KeyManager from '../apis/WalletManager/KeyManager';

interface AddressSelectionPopupProps {
  onSelect: (address: string) => void;
  onClose: () => void;
}

const AddressSelectionPopup: React.FC<AddressSelectionPopupProps> = ({
  onSelect,
  onClose,
}) => {
  const [addresses, setAddresses] = useState<any[]>([]);
  const keyManager = KeyManager();

  useEffect(() => {
    const fetchAddresses = async () => {
      try {
        const keys = await keyManager.retrieveKeys(1); // Assume wallet_id = 1, adjust as needed
        setAddresses(keys);
      } catch (error) {
        console.error('Error fetching addresses:', error);
      }
    };

    fetchAddresses();
  }, []);

  const handleSelect = (address: string) => {
    console.log('Address clicked:', address);
    onSelect(address); // Pass only the selected address to the parent
    onClose(); // Close the popup
  };

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center">
      <div className="bg-white p-6 rounded shadow-lg w-96">
        <h2 className="text-xl font-semibold mb-4">Select an Address</h2>
        <ul>
          {addresses.map((addr) => (
            <li key={addr.id} className="mb-2">
              <button
                className="border p-2 w-full"
                onClick={() => handleSelect(addr.address)}
              >
                {addr.address}
              </button>
            </li>
          ))}
        </ul>
        <button
          className="bg-gray-300 text-gray-700 py-2 px-4 rounded"
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

export default AddressSelectionPopup;
