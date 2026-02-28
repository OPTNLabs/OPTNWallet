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
import { Network } from '../redux/networkSlice';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import EmptyState from '../components/ui/EmptyState';

type QRCodeType = 'address' | 'pubKey' | 'pkh' | 'privkey';
const PRIVKEY_UNLOCK_TAPS = 10;

type WalletKeyPair = {
  address: string;
  tokenAddress: string;
  publicKey: Uint8Array;
  pubkeyHash: Uint8Array;
  changeIndex: number;
  addressIndex: number;
};

const Receive: React.FC = () => {
  const [mainKeyPairs, setMainKeyPairs] = useState<WalletKeyPair[]>([]);
  const [changeKeyPairs, setChangeKeyPairs] = useState<WalletKeyPair[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [selectedPubKey, setSelectedPubKey] = useState<string | null>(null);
  const [selectedPKH, setSelectedPKH] = useState<string | null>(null);
  const [selectedPrivKey, setSelectedPrivKey] = useState<string | null>(null);
  const [isTokenAddress, setIsTokenAddress] = useState(false);
  const [qrCodeType, setQrCodeType] = useState<QRCodeType>('address');
  const [addressType, setAddressType] = useState<'main' | 'change'>('main');
  const [pubKeyTapCount, setPubKeyTapCount] = useState(0);
  const [isPrivKeyUnlocked, setIsPrivKeyUnlocked] = useState(false);

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
        const existingKeys =
          (await KeyService.retrieveKeys(currentWalletId)) as WalletKeyPair[];

        const mainKeys = existingKeys
          .filter((key) => key.changeIndex === 0)
          .sort((a, b) => a.addressIndex - b.addressIndex);

        const changeKeys = existingKeys
          .filter((key) => key.changeIndex === 1)
          .sort((a, b) => a.addressIndex - b.addressIndex);

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
    const keys = (await KeyService.retrieveKeys(wallet_id)) as WalletKeyPair[];
    const selectedKey = keys.find((key) => key.address === address);

    if (!selectedKey) {
      console.error('Selected key not found');
      return;
    }

    const pubkey = hexString(selectedKey.publicKey);
    const pkh = hexString(selectedKey.pubkeyHash);
    const privateKey = await KeyService.fetchAddressPrivateKey(address);

    if (!privateKey) {
      console.error('Selected private key not found');
      return;
    }

    const wif = encodePrivateKeyWif(
      privateKey,
      currentNetwork === Network.MAINNET ? 'mainnet' : 'testnet'
    );

    setPubKeyTapCount(0);
    setIsPrivKeyUnlocked(false);
    setSelectedAddress(isTokenAddress ? tokenAddress : address);
    setSelectedPubKey(pubkey);
    setSelectedPKH(pkh);
    setSelectedPrivKey(wif);
    setQrCodeType('address');
  };

  const handlePubKeyTabClick = () => {
    if (!isPrivKeyUnlocked) {
      const nextTapCount = pubKeyTapCount + 1;
      setPubKeyTapCount(nextTapCount);

      if (nextTapCount >= PRIVKEY_UNLOCK_TAPS) {
        setIsPrivKeyUnlocked(true);
        setQrCodeType('privkey');
        return;
      }
    }

    setQrCodeType('pubKey');
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
    <div className="container mx-auto max-w-md p-4 pb-16 h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] flex flex-col wallet-page">
      <PageHeader title="Receive" subtitle="Choose an address and share QR" compact />

      {!selectedAddress && (
        <SectionCard className="mb-3">
          <div>
            <div className="flex justify-center space-x-4 mb-4 w-full">
              <button
                className={`flex-1 min-w-[120px] px-4 py-2 font-bold rounded text-center ${
                  addressType === 'main'
                    ? 'wallet-segment-active'
                    : 'wallet-segment-inactive'
                }`}
                onClick={() => setAddressType('main')}
              >
                Main <br />
                Addresses
              </button>
              <button
                className={`flex-1 min-w-[120px] px-4 py-2 font-bold rounded text-center ${
                  addressType === 'change'
                    ? 'wallet-segment-active'
                    : 'wallet-segment-inactive'
                }`}
                onClick={() => setAddressType('change')}
              >
                Change <br />
                Addresses
              </button>
            </div>

            <div className="flex flex-row gap-2 items-center justify-center mb-4">
              <span
                className={isTokenAddress ? 'wallet-muted' : 'wallet-text-strong'}
              >
                Regular Address
              </span>
              <div
                onClick={toggleAddressType}
                className={`w-12 h-6 rounded-full flex items-center cursor-pointer relative transition-colors duration-300 border border-[var(--wallet-border)] ${
                  isTokenAddress ? 'bg-[var(--wallet-accent)]' : 'wallet-surface-strong'
                }`}
              >
                <div
                  className={`w-6 h-6 rounded-full shadow-md transform transition-transform duration-300 ${
                    isTokenAddress ? 'translate-x-6' : 'translate-x-0'
                  }`}
                  style={{ backgroundColor: 'var(--wallet-card-bg)' }}
                />
              </div>
              <span
                className={isTokenAddress ? 'wallet-text-strong' : 'wallet-muted'}
              >
                Token Address
              </span>
            </div>
          </div>
        </SectionCard>
      )}

      <div className="flex flex-col items-center space-y-3 flex-1 min-h-0">
        {!selectedAddress ? (
          <div className="overflow-y-auto font-bold w-full flex-1 min-h-0 rounded-md p-1">
            {keyPairsToDisplay.length === 0 ? (
              <EmptyState message="No addresses found for this wallet." />
            ) : (
              keyPairsToDisplay.map((keyPair, index: number) => (
                <div
                  key={index}
                  className="p-4 mb-3 wallet-card cursor-pointer hover:brightness-[0.98]"
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
              ))
            )}
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
                    : qrCodeType === 'pkh'
                      ? selectedPKH || ''
                        : selectedPrivKey || ''
                }
                size={200}
              />
              <p
                className="mt-4 p-2 wallet-surface-strong rounded cursor-pointer hover:brightness-[0.97]"
                onClick={() =>
                  handleCopy(
                    qrCodeType === 'address'
                      ? buildBip21Uri()
                      : qrCodeType === 'pubKey'
                        ? selectedPubKey || ''
                        : qrCodeType === 'pkh'
                          ? selectedPKH || ''
                          : selectedPrivKey || ''
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
                      : shortenTxHash(selectedPrivKey || '')}
              </p>
            </div>

            <div className="flex space-x-4 mt-4 w-full justify-center">
              <button
                className={`px-4 py-2 rounded font-bold ${
                  qrCodeType === 'address'
                    ? 'wallet-segment-active'
                    : 'wallet-segment-inactive'
                }`}
                onClick={() => setQrCodeType('address')}
              >
                Address
              </button>
              <button
                className={`px-4 py-2 rounded font-bold ${
                  qrCodeType === 'pubKey'
                    ? 'wallet-segment-active'
                    : 'wallet-segment-inactive'
                }`}
                onClick={handlePubKeyTabClick}
              >
                PubKey
              </button>
              <button
                className={`px-4 py-2 rounded font-bold ${
                  qrCodeType === 'pkh'
                    ? 'wallet-segment-active'
                    : 'wallet-segment-inactive'
                }`}
                onClick={() => setQrCodeType('pkh')}
              >
                PKH
              </button>
              {isPrivKeyUnlocked && (
                <button
                  className={`px-4 py-2 rounded font-bold ${
                    qrCodeType === 'privkey'
                      ? 'wallet-segment-active'
                      : 'wallet-segment-inactive'
                  }`}
                  onClick={() => setQrCodeType('privkey')}
                >
                  PrivKey
                </button>
              )}
            </div>
            {!isPrivKeyUnlocked && pubKeyTapCount >= 5 && (
              <div className="wallet-surface-strong mt-2 px-4 py-2 rounded text-sm font-bold">
                PrivKey unlock in {PRIVKEY_UNLOCK_TAPS - pubKeyTapCount} taps
              </div>
            )}

            <button
              className="wallet-btn-secondary mt-4 w-full text-xl font-bold"
              onClick={() => {
                setSelectedAddress(null);
                setSelectedPubKey(null);
                setSelectedPKH(null);
                setSelectedPrivKey(null);
                setPubKeyTapCount(0);
                setIsPrivKeyUnlocked(false);
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
