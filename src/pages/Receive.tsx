// src/pages/Receive.tsx

import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import KeyService from '../services/KeyService';
import { Toast } from '@capacitor/toast';
import { shortenTxHash } from '../utils/shortenHash';
import { PREFIX } from '../utils/constants';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { QRCodeSVG } from 'qrcode.react';
import { hexString } from '../utils/hex';
// import { FaCamera } from 'react-icons/fa'; // Optional: If you want to use an icon for the scan button

type QRCodeType = 'address' | 'pubKey' | 'pkh' | 'pk';

const Receive: React.FC = () => {
  const [keyPairs, setKeyPairs] = useState<any[]>([]); // Replace 'any' with appropriate type if available
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [selectedPubKey, setSelectedPubKey] = useState<string | null>(null);
  const [selectedPK, setSelectedPK] = useState<string | null>(null);
  const [selectedPKH, setSelectedPKH] = useState<string | null>(null);
  const [isTokenAddress, setIsTokenAddress] = useState(false);
  // const [showBip21Fields, setShowBip21Fields] = useState(false);
  // const [amount, setAmount] = useState<string>('');
  // const [label, setLabel] = useState<string>('');
  // const [message, setMessage] = useState<string>('');
  const [qrCodeType, setQrCodeType] = useState<QRCodeType>('address');

  // **New State Variables**
  const [publicKeyPressCount, setPublicKeyPressCount] = useState<number>(0);
  const [showPKButton, setShowPKButton] = useState<boolean>(false);
  const [showPKQRCode, setShowPKQRCode] = useState<boolean>(false);

  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const wallet_id = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
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

  // **Reset pressing counter on component unmount**
  useEffect(() => {
    return () => {
      setPublicKeyPressCount(0);
      setShowPKButton(false);
      setShowPKQRCode(false);
    };
  }, []);

  const handleAddressSelect = async (address: string) => {
    const keys = await KeyService.retrieveKeys(wallet_id);
    const selectedKey = keys.find((key: any) => key.address === address);

    if (selectedKey) {
      const pubkey = hexString(selectedKey.publicKey);
      const pkh = hexString(selectedKey.pubkeyHash);
      const pk = hexString(selectedKey.privateKey);

      setSelectedAddress(address);
      setSelectedPubKey(pubkey);
      setSelectedPK(pk);
      setSelectedPKH(pkh);
      setQrCodeType('address'); // Default to address QR code upon selection
    } else {
      console.error('Selected key not found');
    }
  };

  const handleCopyAddress = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      await Toast.show({
        text: 'Address copied to clipboard!',
      });
    } catch (error) {
      console.error('Failed to copy address:', error);
      await Toast.show({
        text: 'Failed to copy address.',
      });
    }
  };

  // const handleCopyPK = async () => {
  //   const confirmCopy = window.confirm(
  //     'Are you sure you want to copy your private key? Exposing it can compromise your funds.'
  //   );
  //   if (confirmCopy && selectedPK) {
  //     try {
  //       await navigator.clipboard.writeText(selectedPK);
  //       await Toast.show({
  //         text: 'Private Key copied to clipboard!',
  //       });
  //     } catch (error) {
  //       console.error('Failed to copy private key:', error);
  //       await Toast.show({
  //         text: 'Failed to copy private key.',
  //       });
  //     }
  //   }
  // };

  const toggleAddressType = () => {
    setIsTokenAddress(!isTokenAddress);
  };

  const buildBip21Uri = () => {
    if (!selectedAddress) return '';

    let uri = `${selectedAddress}`;

    const params = new URLSearchParams();
    // if (amount) params.append('amount', amount);
    // if (label) params.append('label', label);
    // if (message) params.append('message', message);

    if (params.toString()) {
      uri += `?${params.toString()}`;
    }

    return uri;
  };

  return (
    <div className="container mx-auto p-4 pb-16 mt-12 h-full relative">
      <div className="flex flex-col items-center mb-4">
        <div className="text-lg font-bold text-center mb-4">
          Select an Address
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
            className="overflow-y-auto w-full max-w-md flex-grow rounded-md p-4"
            style={{ height: 'calc(100vh - var(--navbar-height) - 200px)' }} // Adjusting height dynamically
          >
            {keyPairs.map((keyPair: any, index: number) => (
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
            {/* **QR Code Display Section** */}
            <div className="flex flex-col items-center mb-4">
              {qrCodeType !== 'pk' ? (
                <>
                  <QRCodeSVG
                    value={
                      qrCodeType === 'address'
                        ? buildBip21Uri()
                        : qrCodeType === 'pubKey'
                          ? selectedPubKey || ''
                          : qrCodeType === 'pkh'
                            ? selectedPKH || ''
                            : ''
                    }
                    size={200}
                  />
                  <p
                    className="mt-4 p-2 bg-gray-200 rounded cursor-pointer hover:bg-gray-300"
                    onClick={() =>
                      handleCopyAddress(
                        qrCodeType === 'address'
                          ? buildBip21Uri()
                          : qrCodeType === 'pubKey'
                            ? selectedPubKey || ''
                            : qrCodeType === 'pkh'
                              ? selectedPKH || ''
                              : ''
                      )
                    }
                  >
                    {qrCodeType === 'address'
                      ? shortenTxHash(
                          selectedAddress,
                          PREFIX[currentNetwork].length
                        )
                      : qrCodeType === 'pubKey'
                        ? shortenTxHash(selectedPubKey || '')
                        : qrCodeType === 'pkh'
                          ? shortenTxHash(selectedPKH || '')
                          : ''}
                  </p>
                </>
              ) : showPKQRCode ? (
                <>
                  <QRCodeSVG value={selectedPK || ''} size={200} />
                  <p
                    className="mt-4 p-2 bg-gray-200 rounded cursor-pointer hover:bg-gray-300"
                    // onClick={handleCopyPK}
                  >
                    {shortenTxHash(
                      selectedPK || '',
                      PREFIX[currentNetwork].length
                    )}
                  </p>
                  {/* <div className="mt-2 text-red-500">
                    Warning: Displaying your private key can compromise your
                    funds. Ensure you keep it secure.
                  </div> */}
                </>
              ) : (
                <>
                  <button
                    className="mt-4 px-4 py-2 font-bold bg-red-500 text-white rounded hover:bg-red-700"
                    onClick={() => setShowPKQRCode(true)}
                  >
                    Show Private Key
                  </button>
                  <div className="mt-2 text-center py-2 text-red-500">
                    Warning: Displaying your private key can compromise your
                    funds. Ensure you keep it secure.
                  </div>
                </>
              )}
            </div>

            {/* **Optional: Specify Amount Fields** */}
            {/* {qrCodeType === 'address' && (
              <button
                className="mt-4 text-sm text-blue-500 underline"
                onClick={() => setShowBip21Fields(!showBip21Fields)}
              >
                Specify Amount
              </button>
            )} */}
            {/* {showBip21Fields && (
              <>
                <div className="w-full max-w-md mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Amount (BCH)
                  </label>
                  <input
                    type="text"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="border p-2 w-full rounded-md"
                    placeholder="Enter amount in BCH (e.g. 0.01)"
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
            )} */}

            {/* **Toggle Buttons with Dynamic Prompt** */}
            <div className="flex flex-col items-center relative w-full max-w-md">
              {/* **Dynamic Press Count Prompt** */}
              {publicKeyPressCount >= 6 && publicKeyPressCount < 10 && (
                <div className="absolute -top-6 mb-2 text-sm text-red-500 text-center">
                  Press {10 - publicKeyPressCount} more time
                  {10 - publicKeyPressCount > 1 ? 's' : ''} to unlock the
                  Private Key button.
                </div>
              )}
              <div className="flex space-x-4 mt-4 w-full justify-center">
                <button
                  className={`px-4 py-2 rounded ${
                    qrCodeType === 'address'
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-200 text-gray-700'
                  }`}
                  onClick={() => {
                    // Reset the publicKeyPressCount since a different button is clicked
                    setPublicKeyPressCount(0);
                    setQrCodeType('address');
                  }}
                >
                  Address
                </button>
                <button
                  className={`px-4 py-2 rounded ${
                    qrCodeType === 'pubKey'
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-200 text-gray-700'
                  }`}
                  onClick={() => {
                    if (!showPKButton) {
                      const newCount = publicKeyPressCount + 1;
                      if (newCount >= 10) {
                        setShowPKButton(true);
                        setPublicKeyPressCount(0); // Reset the count after revealing PK button
                        Toast.show({
                          text: 'Private Key button unlocked!',
                        });
                      } else {
                        setPublicKeyPressCount(newCount);
                        if (newCount >= 6) {
                          const pressesLeft = 10 - newCount;
                          Toast.show({
                            text: `Press the Public Key button ${pressesLeft} more time${
                              pressesLeft > 1 ? 's' : ''
                            } to unlock the Private Key button.`,
                          });
                        } else {
                          Toast.show({
                            text: `Public Key button pressed ${newCount} time${
                              newCount > 1 ? 's' : ''
                            }.`,
                          });
                        }
                      }
                    }
                    setQrCodeType('pubKey');
                  }}
                >
                  PubKey
                </button>
                <button
                  className={`px-4 py-2 rounded ${
                    qrCodeType === 'pkh'
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-200 text-gray-700'
                  }`}
                  onClick={() => {
                    // Reset the publicKeyPressCount since a different button is clicked
                    setPublicKeyPressCount(0);
                    setQrCodeType('pkh');
                  }}
                >
                  PKH
                </button>
                {/* **Conditionally Render the PK Button** */}
                {showPKButton && (
                  <button
                    className={`px-4 py-2 rounded ${
                      qrCodeType === 'pk'
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-200 text-gray-700'
                    }`}
                    onClick={() => {
                      setQrCodeType('pk');
                      setShowPKQRCode(false); // Ensure QR code is hidden when PK is selected
                    }}
                  >
                    Sig
                  </button>
                )}
              </div>
            </div>

            {/* **Optional: Display press count** */}
            {/* {!showPKButton && publicKeyPressCount > 0 && (
              <div className="mt-2 text-sm text-gray-600">
                Public Key button pressed {publicKeyPressCount} time
                {publicKeyPressCount > 1 ? 's' : ''}.
              </div>
            )} */}

            {/* **Back Button** */}
            <button
              className="mt-4 w-full text-xl font-bold py-2 bg-red-500 text-white rounded hover:bg-red-600"
              onClick={() => {
                setSelectedAddress(null);
                setShowPKButton(false);
                setShowPKQRCode(false);
              }}
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
