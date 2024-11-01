import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import KeyService from '../services/KeyService';
import { Toast } from '@capacitor/toast';
import { shortenTxHash } from '../utils/shortenHash';
import { PREFIX } from '../utils/constants';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { QRCodeSVG } from 'qrcode.react';

const Receive: React.FC = () => {
  const [keyPairs, setKeyPairs] = useState([]);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [isTokenAddress, setIsTokenAddress] = useState(false);
  const [showBip21Fields, setShowBip21Fields] = useState(false);
  const [amount, setAmount] = useState<string>('');
  const [label, setLabel] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );

  // Fetch existing keys when component is mounted
  useEffect(() => {
    const fetchKeys = async () => {
      if (!currentWalletId) return;

      try {
        const existingKeys = await KeyService.retrieveKeys(currentWalletId);
        if (existingKeys.length > 0) {
          setKeyPairs(existingKeys);
        } else {
          console.error('No keys found for the current wallet');
        }
      } catch (error) {
        console.error('Failed to fetch keys:', error);
      }
    };

    fetchKeys();
  }, [currentWalletId]);

  const handleAddressSelect = (address: string) => {
    setSelectedAddress(address);
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

  const toggleAddressType = () => {
    setIsTokenAddress(!isTokenAddress);
  };

  const buildBip21Uri = () => {
    if (!selectedAddress) return '';

    let uri = `${selectedAddress}`;

    const params = new URLSearchParams();
    if (amount) params.append('amount', amount);
    if (label) params.append('label', label);
    if (message) params.append('message', message);

    if (params.toString()) {
      uri += `?${params.toString()}`;
    }

    return uri;
  };

  return (
    <div className="container mx-auto p-4 pb-16 mt-12 h-full">
      <div className="flex flex-col items-center mb-4">
        <div className="text-lg font-bold text-center mb-4">
          Select an Address to Receive Payments
        </div>
        {!selectedAddress && (
          <div className="flex flex-row gap-2 items-center text-gray-800 mb-4">
            <span
              className={`${isTokenAddress ? 'text-gray-400' : 'text-black'}`}
            >
              Regular Address
            </span>
            <div
              onClick={toggleAddressType}
              className={`w-12 h-6 bg-gray-300 rounded-full flex items-center cursor-pointer relative transition-colors duration-300 ${
                isTokenAddress ? 'bg-orange-400' : 'bg-green-400'
              }`}
            >
              <div
                className={`w-6 h-6 bg-white rounded-full shadow-md transform transition-transform duration-300 ${
                  isTokenAddress ? 'translate-x-6' : 'translate-x'
                }`}
              />
            </div>
            <span
              className={`${isTokenAddress ? 'text-black' : 'text-gray-400'}`}
            >
              Token Address
            </span>
          </div>
        )}
      </div>
      <div className="flex flex-col items-center space-y-4 h-full">
        {!selectedAddress ? (
          <div
            className="overflow-y-auto w-full max-w-md flex-grow  rounded-md p-4"
            style={{ height: 'calc(100vh - var(--navbar-height) - 200px)' }} // Adjusting height dynamically
          >
            {keyPairs.map((keyPair, index) => (
              <div
                key={index}
                className="p-4 mb-4 bg-white rounded-lg shadow-md cursor-pointer hover:bg-gray-100"
                onClick={() =>
                  handleAddressSelect(
                    isTokenAddress ? keyPair.tokenAddress : keyPair.address
                  )
                }
              >
                <p>
                  <strong>
                    {isTokenAddress ? 'Token Address:' : 'Regular Address:'}
                  </strong>{' '}
                  {shortenTxHash(
                    isTokenAddress ? keyPair.tokenAddress : keyPair.address,
                    PREFIX[currentNetwork].length
                  )}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center mb-4">
              <QRCodeSVG
                value={buildBip21Uri()}
                size={200}
                imageSettings={{
                  src: '/assets/images/OPTNUIkeyline.png',
                  height: 40, // Adjust height as needed
                  width: 40, // Adjust width as needed
                  excavate: true, // To clear the space around the image so it is more visible
                }}
              />
              <p
                className="mt-4 p-2 bg-gray-200 rounded cursor-pointer hover:bg-gray-300"
                onClick={() => handleCopyAddress(buildBip21Uri())}
              >
                {shortenTxHash(selectedAddress, PREFIX[currentNetwork].length)}
              </p>
            </div>
            <button
              className="mt-4 text-sm text-blue-500 underline"
              onClick={() => setShowBip21Fields(!showBip21Fields)}
            >
              Specify Amount
            </button>
            {showBip21Fields && (
              <>
                <div className="w-full max-w-md mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Amount (BTC)
                  </label>
                  <input
                    type="text"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="border p-2 w-full rounded-md"
                    placeholder="Enter amount in BTC (e.g. 0.01)"
                  />
                </div>
                <div className="w-full max-w-md mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Label
                  </label>
                  <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    className="border p-2 w-full rounded-md"
                    placeholder="Enter label (e.g. Donation)"
                  />
                </div>
                <div className="w-full max-w-md mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Message
                  </label>
                  <input
                    type="text"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    className="border p-2 w-full rounded-md"
                    placeholder="Enter message (e.g. Thank you for your support!)"
                  />
                </div>
              </>
            )}
            <button
              className="mt-4 w-full bg-red-500 text-white rounded hover:bg-red-600"
              onClick={() => setSelectedAddress(null)}
            >
              Back
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default Receive;
