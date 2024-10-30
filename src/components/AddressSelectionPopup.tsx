import React, { useState, useEffect } from 'react';
import KeyService from '../services/KeyService';
import { shortenTxHash } from '../utils/shortenHash';
import { PREFIX } from '../utils/constants';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';

interface AddressSelectionPopupProps {
  onSelect: (address: string) => void;
  onClose: () => void;
}

const AddressSelectionPopup: React.FC<AddressSelectionPopupProps> = ({
  onSelect,
  onClose,
}) => {
  const [addresses, setAddresses] = useState<any[]>([]);
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );

  useEffect(() => {
    const fetchAddresses = async () => {
      try {
        const keys = await KeyService.retrieveKeys(1); // Assuming wallet_id = 1
        setAddresses(keys);
      } catch (error) {
        console.error('Error fetching addresses:', error);
      }
    };

    fetchAddresses();
  }, []);

  const handleSelect = (address: string) => {
    console.log('Address clicked:', address); // Debugging log
    onSelect(address); // Pass selected address to parent
  };

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50">
      {/* Popup Container */}
      <div className="bg-white p-6 rounded shadow-lg w-full max-w-md">
        <h2 className="text-xl font-semibold mb-4">Select an Address</h2>
        {/* Scrollable address list */}
        <div className="max-h-64 overflow-y-auto mb-4">
          <ul>
            {addresses.map((addr) => (
              <li key={addr.id} className="mb-2">
                <button
                  className="border p-2 w-full text-left break-words"
                  onClick={() => handleSelect(addr.address)}
                >
                  {shortenTxHash(addr.address, PREFIX[currentNetwork].length)}
                </button>
              </li>
            ))}
          </ul>
        </div>
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
