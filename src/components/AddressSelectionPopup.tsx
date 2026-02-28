import React, { useState, useEffect } from 'react';
import KeyService from '../services/KeyService';
import { shortenTxHash } from '../utils/shortenHash';
import { PREFIX } from '../utils/constants';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { selectWalletId } from '../redux/walletSlice';

interface AddressSelectionPopupProps {
  onSelect: (address: string) => void;
  onClose: () => void;
}

interface SelectableAddress {
  id: number;
  address: string;
}

const AddressSelectionPopup: React.FC<AddressSelectionPopupProps> = ({
  onSelect,
  onClose,
}) => {
  const [addresses, setAddresses] = useState<SelectableAddress[]>([]);
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const walletId = useSelector(selectWalletId);

  useEffect(() => {
    const fetchAddresses = async () => {
      if (walletId <= 0) {
        setAddresses([]);
        return;
      }
      try {
        const keys = await KeyService.retrieveKeys(walletId);
        setAddresses(
          keys.map((key) => ({
            id: key.id,
            address: key.address,
          }))
        );
      } catch (error) {
        console.error('Error fetching addresses:', error);
      }
    };

    fetchAddresses();
  }, [walletId]);

  const handleSelect = (address: string) => {
    // console.log('Address clicked:', address); // Debugging log
    onSelect(address); // Pass selected address to parent
  };

  return (
    <div className="wallet-popup-backdrop">
      {/* Popup Container */}
      <div className="wallet-popup-panel w-full max-w-md">
        <h2 className="flex flex-col items-center text-xl font-bold mb-4">
          Select an Address
        </h2>
        {/* Scrollable address list */}
        <div className="max-h-64 overflow-y-auto mb-4">
          <ul>
            {addresses.map((addr) => (
              <li key={addr.id} className="mb-2">
                <button
                  className="wallet-card hover:brightness-[0.98] flex flex-col items-center p-2 w-full text-left break-words"
                  onClick={() => handleSelect(addr.address)}
                >
                  {shortenTxHash(addr.address, PREFIX[currentNetwork].length)}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col">
          <button
            className="wallet-btn-danger"
            onClick={onClose}
          >
            Back
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddressSelectionPopup;
