// src/pages/Receive.tsx

import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import KeyService from '../services/KeyService';
import { Toast } from '@capacitor/toast';
import { shortenTxHash } from '../utils/shortenHash';
import { COIN_TYPE, PREFIX } from '../utils/constants';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { QRCodeSVG } from 'qrcode.react';
import { hexString } from '../utils/hex';
import { encodePrivateKeyWif } from '@bitauth/libauth';

type QRCodeType = 'address' | 'pubKey' | 'pkh' | 'pk';

const Receive: React.FC = () => {
  const [mainKeyPairs, setMainKeyPairs] = useState<any[]>([]);
  const [changeKeyPairs, setChangeKeyPairs] = useState<any[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [selectedPubKey, setSelectedPubKey] = useState<string | null>(null);
  const [selectedPK, setSelectedPK] = useState<string | null>(null);
  const [selectedPKH, setSelectedPKH] = useState<string | null>(null);
  const [isTokenAddress, setIsTokenAddress] = useState(false);
  const [qrCodeType, setQrCodeType] = useState<QRCodeType>('address');
  const [publicKeyPressCount, setPublicKeyPressCount] = useState<number>(0);
  const [showPKButton, setShowPKButton] = useState<boolean>(false);
  const [showPKQRCode, setShowPKQRCode] = useState<boolean>(false);
  // New state for toggling main/change key pairs
  const [addressType, setAddressType] = useState<'main' | 'change'>('main');

  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const wallet_id = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  useEffect(() => {
    const fetchKeys = async () => {
      if (!currentWalletId) return;

      try {
        const existingKeys = await KeyService.retrieveKeys(currentWalletId);
        const mainKeys = existingKeys.filter((key) => key.changeIndex === 0);
        const changeKeys = existingKeys.filter((key) => key.changeIndex === 1);
        if (mainKeys.length > 0 && changeKeys.length > 0) {
          setMainKeyPairs(mainKeys);
          setChangeKeyPairs(changeKeys);
        } else {
          console.error('No keys found for the current wallet');
        }
      } catch (error) {
        console.error('Failed to fetch keys:', error);
      }
    };

    fetchKeys();
  }, [currentWalletId]);

  useEffect(() => {
    return () => {
      setPublicKeyPressCount(0);
      setShowPKButton(false);
      setShowPKQRCode(false);
    };
  }, []);

  const handleAddressSelect = async (tokenAddress: string, address: string) => {
    const keys = await KeyService.retrieveKeys(wallet_id);
    const selectedKey = keys.find((key: any) => key.address === address);

    if (selectedKey) {
      const pubkey = hexString(selectedKey.publicKey);
      const pkh = hexString(selectedKey.pubkeyHash);
      const pk = encodePrivateKeyWif(selectedKey.privateKey, 'testnet');

      if (isTokenAddress) {
        setSelectedAddress(tokenAddress);
      } else {
        setSelectedAddress(address);
      }
      setSelectedPubKey(pubkey);
      setSelectedPK(pk);
      setSelectedPKH(pkh);
      setQrCodeType('address');
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

  const handleCopyPK = async () => {
    const confirmCopy = window.confirm(
      'Are you sure you want to copy your private key? Exposing it can compromise your funds.'
    );
    if (confirmCopy && selectedPK) {
      try {
        await navigator.clipboard.writeText(selectedPK);
        await Toast.show({
          text: 'Private Key copied to clipboard!',
        });
      } catch (error) {
        console.error('Failed to copy private key:', error);
        await Toast.show({
          text: 'Failed to copy private key.',
        });
      }
    }
  };

  const toggleAddressType = () => {
    setIsTokenAddress(!isTokenAddress);
  };

  const buildBip21Uri = () => {
    if (!selectedAddress) return '';
    let uri = `${selectedAddress}`;
    const params = new URLSearchParams();
    if (params.toString()) {
      uri += `?${params.toString()}`;
    }
    return uri;
  };

  // Determine which key pairs to display
  const keyPairsToDisplay =
    addressType === 'main' ? mainKeyPairs : changeKeyPairs;

  return (
    <div className="container mx-auto p-4 pb-16 mt-12 h-full relative">
      <div className="flex flex-col items-center mb-4">
        <div className="text-lg font-bold text-center mb-4">
          Select an Address
        </div>
        {/* New toggle buttons for main/change */}

        {!selectedAddress && (
          <div>
            <div className="flex justify-center space-x-4 mb-4">
              <button
                className={`px-4 py-2 font-bold rounded ${
                  addressType === 'main'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700'
                } ${addressType === 'main' ? 'hover:bg-blue-600' : 'hover:bg-gray-300'}`}
                onClick={() => setAddressType('main')}
              >
                Main Addresses
              </button>
              <button
                className={`px-4 py-2 font-bold rounded ${
                  addressType === 'change'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700'
                } ${addressType === 'change' ? 'hover:bg-blue-600' : 'hover:bg-gray-300'}`}
                onClick={() => setAddressType('change')}
              >
                Change Addresses
              </button>
            </div>
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
          </div>
        )}
      </div>
      <div className="flex flex-col items-center space-y-4 h-full">
        {!selectedAddress ? (
          <div
            className="overflow-y-auto font-bold w-full max-w-md flex-grow rounded-md p-4"
            style={{ height: 'calc(100vh - var(--navbar-height) - 250px)' }}
          >
            {keyPairsToDisplay.map((keyPair: any, index: number) => (
              <div
                key={index}
                className="p-4 mb-4 bg-white rounded-lg shadow-md cursor-pointer hover:bg-gray-500 hover:text-white"
                onClick={() =>
                  handleAddressSelect(keyPair.tokenAddress, keyPair.address)
                }
              >
                <p>
                  {shortenTxHash(
                    isTokenAddress ? keyPair.tokenAddress : keyPair.address,
                    PREFIX[currentNetwork].length
                  )}
                  <br />
                  {`m/44'/${PREFIX[currentNetwork] === PREFIX.mainnet ? COIN_TYPE.bitcoincash : COIN_TYPE.testnet}'/0'/${keyPair.changeIndex}/${keyPair.addressIndex}`}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <>
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
                    onClick={handleCopyPK}
                  >
                    {shortenTxHash(
                      selectedPK || ''
                      // PREFIX[currentNetwork].length
                    )}
                  </p>
                </>
              ) : (
                <>
                  <div className="flex justify-center items-base line mt-4">
                    <img
                      src="/assets/images/OPTNWelcome3.png"
                      alt="Welcome"
                      className="max-w-full h-auto"
                      width={'32%'}
                      height={'32%'}
                    />
                  </div>
                  <button
                    className="mt-4 px-4 py-2 font-bold bg-red-500 text-white rounded hover:bg-red-700"
                    onClick={() => setShowPKQRCode(true)}
                  >
                    Show Private Key
                  </button>
                  <div className="mt-2 text-center text-red-500">
                    Warning: Displaying your private key can compromise your
                    funds. Ensure you keep it secure.
                  </div>
                </>
              )}
            </div>
            <div className="flex flex-col items-center relative w-full max-w-md">
              {publicKeyPressCount >= 6 && publicKeyPressCount < 10 && (
                <div className="absolute -top-6 mb-2 text-sm text-red-500 text-center">
                  Press {10 - publicKeyPressCount} more time
                  {10 - publicKeyPressCount > 1 ? 's' : ''} to unlock the
                  Private Key button.
                </div>
              )}
              <div className="flex space-x-4 mt-4 w-full justify-center">
                <button
                  className={`px-4 py-2 rounded font-bold ${
                    qrCodeType === 'address'
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-200 text-gray-700'
                  }`}
                  onClick={() => {
                    setPublicKeyPressCount(0);
                    setQrCodeType('address');
                  }}
                >
                  Address
                </button>
                <button
                  className={`px-4 py-2 rounded font-bold ${
                    qrCodeType === 'pubKey'
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-200 text-gray-700'
                  }`}
                  onClick={() => {
                    if (!showPKButton) {
                      const newCount = publicKeyPressCount + 1;
                      if (newCount >= 10) {
                        setShowPKButton(true);
                        setPublicKeyPressCount(0);
                        Toast.show({
                          text: 'Private Key button unlocked!',
                        });
                      } else {
                        setPublicKeyPressCount(newCount);
                      }
                    }
                    setQrCodeType('pubKey');
                  }}
                >
                  PubKey
                </button>
                <button
                  className={`px-4 py-2 rounded font-bold ${
                    qrCodeType === 'pkh'
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-200 text-gray-700'
                  }`}
                  onClick={() => {
                    setPublicKeyPressCount(0);
                    setQrCodeType('pkh');
                  }}
                >
                  PKH
                </button>
                {showPKButton && (
                  <button
                    className={`px-4 py-2 rounded font-bold ${
                      qrCodeType === 'pk'
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-200 text-gray-700'
                    }`}
                    onClick={() => {
                      setQrCodeType('pk');
                      setShowPKQRCode(false);
                    }}
                  >
                    Sig
                  </button>
                )}
              </div>
            </div>
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
