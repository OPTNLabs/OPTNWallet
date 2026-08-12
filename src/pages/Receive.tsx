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

type QRCodeType = 'address' | 'pubKey' | 'pkh';

const Receive: React.FC = () => {
  const [mainKeyPairs, setMainKeyPairs] = useState<any[]>([]);
  const [changeKeyPairs, setChangeKeyPairs] = useState<any[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [selectedPubKey, setSelectedPubKey] = useState<string | null>(null);
  const [selectedPKH, setSelectedPKH] = useState<string | null>(null);
  const [isTokenAddress, setIsTokenAddress] = useState(false);
  const [qrCodeType, setQrCodeType] = useState<QRCodeType>('address');
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

        const mainKeys = existingKeys
          .filter((key: any) => key.changeIndex === 0)
          .sort((a: any, b: any) => a.addressIndex - b.addressIndex);

        const changeKeys = existingKeys
          .filter((key: any) => key.changeIndex === 1)
          .sort((a: any, b: any) => a.addressIndex - b.addressIndex);

        // ✅ allow either list to exist
        if (mainKeys.length > 0 || changeKeys.length > 0) {
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

  const handleAddressSelect = async (tokenAddress: string, address: string) => {
    const keys = await KeyService.retrieveKeys(wallet_id);
    const selectedKey = keys.find((key: any) => key.address === address);

    if (!selectedKey) {
      console.error('Selected key not found');
      return;
    }

    const pubkey = hexString(selectedKey.publicKey);
    const pkh = hexString(selectedKey.pubkeyHash);

    setSelectedAddress(isTokenAddress ? tokenAddress : address);
    setSelectedPubKey(pubkey);
    setSelectedPKH(pkh);
    setQrCodeType('address');
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      await Toast.show({ text: 'Copied to clipboard!' });
    } catch (error) {
      console.error('Failed to copy:', error);
      await Toast.show({ text: 'Failed to copy.' });
    }
  };

  const toggleAddressType = () => {
    setIsTokenAddress(!isTokenAddress);
  };

  const buildBip21Uri = () => {
    if (!selectedAddress) return '';
    // Keep it simple for now; add amount/label/message params later if needed
    return selectedAddress;
  };

  const keyPairsToDisplay =
    addressType === 'main' ? mainKeyPairs : changeKeyPairs;

  return (
    <div className="container mx-auto p-4 pb-16 h-full relative">
      <div className="flex flex-col items-center mb-4">
        <div className="flex justify-center mt-4 my-4">
          <img
            src="/assets/images/OPTNWelcome1.png"
            alt="Welcome"
            className="w-3/4 h-auto"
          />
        </div>

        {!selectedAddress && (
          <div>
            <div className="flex justify-center space-x-4 mb-4 w-full max-w-md">
              <button
                className={`flex-1 min-w-[120px] px-4 py-2 font-bold rounded text-center ${
                  addressType === 'main'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700'
                } ${
                  addressType === 'main'
                    ? 'hover:bg-blue-600'
                    : 'hover:bg-gray-300'
                }`}
                onClick={() => setAddressType('main')}
              >
                Main <br />
                Addresses
              </button>
              <button
                className={`flex-1 min-w-[120px] px-4 py-2 font-bold rounded text-center ${
                  addressType === 'change'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700'
                } ${
                  addressType === 'change'
                    ? 'hover:bg-blue-600'
                    : 'hover:bg-gray-300'
                }`}
                onClick={() => setAddressType('change')}
              >
                Change <br />
                Addresses
              </button>
            </div>

            <div className="flex flex-row gap-2 items-center justify-center text-gray-800 mb-4">
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
                  {`m/44'/${
                    PREFIX[currentNetwork] === PREFIX.mainnet
                      ? COIN_TYPE.bitcoincash
                      : COIN_TYPE.testnet
                  }'/0'/${keyPair.changeIndex}/${keyPair.addressIndex}`}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="flex flex-col items-center mb-4">
              <QRCodeSVG
                value={
                  qrCodeType === 'address'
                    ? buildBip21Uri()
                    : qrCodeType === 'pubKey'
                      ? selectedPubKey || ''
                      : selectedPKH || ''
                }
                size={200}
              />
              <p
                className="mt-4 p-2 bg-gray-200 rounded cursor-pointer hover:bg-gray-300"
                onClick={() =>
                  handleCopy(
                    qrCodeType === 'address'
                      ? buildBip21Uri()
                      : qrCodeType === 'pubKey'
                        ? selectedPubKey || ''
                        : selectedPKH || ''
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
                    : shortenTxHash(selectedPKH || '')}
              </p>
            </div>

            <div className="flex space-x-4 mt-4 w-full justify-center">
              <button
                className={`px-4 py-2 rounded font-bold ${
                  qrCodeType === 'address'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700'
                }`}
                onClick={() => setQrCodeType('address')}
              >
                Address
              </button>
              <button
                className={`px-4 py-2 rounded font-bold ${
                  qrCodeType === 'pubKey'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700'
                }`}
                onClick={() => setQrCodeType('pubKey')}
              >
                PubKey
              </button>
              <button
                className={`px-4 py-2 rounded font-bold ${
                  qrCodeType === 'pkh'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-200 text-gray-700'
                }`}
                onClick={() => setQrCodeType('pkh')}
              >
                PKH
              </button>
            </div>

            <button
              className="mt-4 w-full text-xl font-bold py-2 bg-red-500 text-white rounded hover:bg-red-600"
              onClick={() => {
                setSelectedAddress(null);
                setSelectedPubKey(null);
                setSelectedPKH(null);
                setQrCodeType('address');
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
