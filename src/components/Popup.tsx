import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import RegularUTXOs from '../components/RegularUTXOs';
import CashTokenUTXOs from '../components/CashTokenUTXOs';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { PREFIX } from '../utils/constants';
import { shortenTxHash } from '../utils/shortenHash';
import QRCode from 'react-qr-code';
import { Toast } from '@capacitor/toast';

interface PopupProps {
  keyPairs: any[];
  reduxUTXOs: Record<string, any[]>;
  loading: Record<string, boolean>;
  togglePopup: () => void;
}

enum UTXOType {
  NONE,
  REGULAR,
  CASH_TOKEN,
}

const Popup: React.FC<PopupProps> = ({
  keyPairs,
  reduxUTXOs,
  loading,
  togglePopup,
}) => {
  const [selectedKeyPairIndex, setSelectedKeyPairIndex] = useState<
    number | null
  >(null);
  const [selectedUTXOType, setSelectedUTXOType] = useState<UTXOType>(
    UTXOType.NONE
  );
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );

  const handleAddressClick = (index: number) => {
    setSelectedKeyPairIndex(index);
    setSelectedUTXOType(UTXOType.NONE); // Reset UTXO type on address click
  };

  const handleBackClick = () => {
    setSelectedKeyPairIndex(null);
    setSelectedUTXOType(UTXOType.NONE); // Reset UTXO type when going back
  };

  const handleCopyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      await Toast.show({
        text: 'Address copied to clipboard!',
      });
    } catch (error) {
      console.error('Failed to copy address:', error);
    }
  };

  const toggleUTXOType = (type: UTXOType) => {
    setSelectedUTXOType((prevType) =>
      prevType === type ? UTXOType.NONE : type
    );
  };

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50">
      <div className="relative top-20 mx-auto p-5 w-3/4 max-w-3xl bg-white rounded-md shadow-lg min-h-[500px] flex flex-col">
        {selectedKeyPairIndex === null ? (
          <>
            <div className="text-center text-lg font-bold">
              All Address Information
            </div>
            <div className="max-h-96 overflow-y-auto">
              {keyPairs.map((keyPair, index) => (
                <div
                  key={index}
                  className="p-4 mb-4 bg-white rounded-lg shadow-md cursor-pointer hover:bg-gray-100"
                  onClick={() => handleAddressClick(index)}
                >
                  <p>
                    <strong>Address:</strong>{' '}
                    {shortenTxHash(
                      keyPair.address,
                      PREFIX[currentNetwork].length
                    )}
                  </p>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col items-center mb-4">
              <QRCode
                value={keyPairs[selectedKeyPairIndex].address}
                size={128}
              />
              <p
                className="mt-4 p-2 bg-gray-200 rounded cursor-pointer hover:bg-gray-300"
                onClick={() =>
                  handleCopyAddress(keyPairs[selectedKeyPairIndex].address)
                }
              >
                {shortenTxHash(
                  keyPairs[selectedKeyPairIndex].address,
                  PREFIX[currentNetwork].length
                )}
              </p>
            </div>

            <div className="flex justify-around mb-4">
              <button
                className={`py-1 rounded w-1/2 ${
                  selectedUTXOType === UTXOType.REGULAR
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-300'
                } hover:bg-blue-600`}
                onClick={() => toggleUTXOType(UTXOType.REGULAR)}
              >
                Regular UTXOs
              </button>
              <button
                className={`py-1 rounded w-1/ ${
                  selectedUTXOType === UTXOType.CASH_TOKEN
                    ? 'bg-green-500 text-white'
                    : 'bg-gray-300'
                } hover:bg-green-600`}
                onClick={() => toggleUTXOType(UTXOType.CASH_TOKEN)}
              >
                CashToken UTXOs
              </button>
            </div>

            {(selectedUTXOType === UTXOType.REGULAR ||
              selectedUTXOType === UTXOType.CASH_TOKEN) && (
              <div className="max-h-36 overflow-y-auto p-4 mb-4 bg-white rounded-lg shadow-md">
                {selectedUTXOType === UTXOType.REGULAR && (
                  <RegularUTXOs
                    utxos={
                      reduxUTXOs[
                        keyPairs[selectedKeyPairIndex].address
                      ]?.filter((utxo) => !utxo.token_data) || []
                    }
                    loading={loading[keyPairs[selectedKeyPairIndex].address]}
                  />
                )}
                {selectedUTXOType === UTXOType.CASH_TOKEN && (
                  <CashTokenUTXOs
                    utxos={
                      reduxUTXOs[
                        keyPairs[selectedKeyPairIndex].address
                      ]?.filter((utxo) => utxo.token_data) || []
                    }
                    loading={loading[keyPairs[selectedKeyPairIndex].address]}
                  />
                )}
              </div>
            )}
          </>
        )}
        <div className="mt-auto w-full">
          {selectedKeyPairIndex === null ? (
            <button
              className="w-full bg-red-500 text-white rounded hover:bg-red-600"
              onClick={togglePopup}
            >
              Close
            </button>
          ) : (
            <button
              className="w-full bg-blue-500 text-white rounded hover:bg-blue-600"
              onClick={handleBackClick}
            >
              Back
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Popup;
