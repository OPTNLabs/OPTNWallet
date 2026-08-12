// src/pages/Receive.tsx
import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../redux/store';
import KeyService from '../services/KeyService';
import { Toast } from '@capacitor/toast';
import { shortenTxHash } from '../utils/shortenHash';
import { PREFIX } from '../utils/constants';
import { getBchAddressPath } from '../services/HdWalletService';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { QRCodeSVG } from 'qrcode.react';
import { hexString } from '../utils/hex';
import { encodePrivateKeyWif } from '@bitauth/libauth';
import { Network } from '../redux/networkSlice';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import EmptyState from '../components/ui/EmptyState';
import { buildBip21Uri } from '../utils/bip21';
import { zeroize } from '../utils/secureMemory';

type QRCodeType = 'address' | 'pubKey' | 'pkh' | 'privkey';
const PRIVKEY_UNLOCK_TAPS = 10;
const ALLOW_PRIVATE_KEY_VIEW = import.meta.env.DEV;

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
  const [selectedAddressPair, setSelectedAddressPair] = useState<{
    address: string;
    tokenAddress: string;
  } | null>(null);
  const [qrCodeType, setQrCodeType] = useState<QRCodeType>('address');
  const [addressType, setAddressType] = useState<'main' | 'change'>('main');
  const [pubKeyTapCount, setPubKeyTapCount] = useState(0);
  const [isPrivKeyUnlocked, setIsPrivKeyUnlocked] = useState(false);
  const [showBip21Popup, setShowBip21Popup] = useState(false);
  const [bip21Amount, setBip21Amount] = useState('');
  const [bip21Label, setBip21Label] = useState('');
  const [bip21Message, setBip21Message] = useState('');

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
        const existingKeys = (await KeyService.retrieveKeys(
          currentWalletId
        )) as WalletKeyPair[];

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
    let wif: string | null = null;
    if (ALLOW_PRIVATE_KEY_VIEW) {
      const privateKey = await KeyService.fetchAddressPrivateKey(address);
      if (!privateKey) {
        console.error('Selected private key not found');
        return;
      }
      try {
        wif = encodePrivateKeyWif(
          privateKey,
          currentNetwork === Network.MAINNET ? 'mainnet' : 'testnet'
        );
      } finally {
        zeroize(privateKey);
      }
    }

    setPubKeyTapCount(0);
    setIsPrivKeyUnlocked(false);
    setSelectedAddressPair({ address, tokenAddress });
    setSelectedAddress(address);
    setSelectedPubKey(pubkey);
    setSelectedPKH(pkh);
    setSelectedPrivKey(wif);
    setIsTokenAddress(false);
    setQrCodeType('address');
    setShowBip21Popup(false);
    setBip21Amount('');
    setBip21Label('');
    setBip21Message('');
  };

  const handlePubKeyTabClick = () => {
    if (!ALLOW_PRIVATE_KEY_VIEW) {
      setQrCodeType('pubKey');
      return;
    }

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
    if (!selectedAddressPair) return;
    const nextIsTokenAddress = !isTokenAddress;
    setIsTokenAddress(nextIsTokenAddress);
    setSelectedAddress(
      nextIsTokenAddress
        ? selectedAddressPair.tokenAddress
        : selectedAddressPair.address
    );
  };

  const handleBip21AmountChange = (value: string) => {
    const normalized = value.replace(',', '.').replace(/[^0-9.]/g, '');
    const parts = normalized.split('.');
    const whole = parts[0] || '';
    const decimal = parts.slice(1).join('').slice(0, 8);
    setBip21Amount(parts.length > 1 ? `${whole}.${decimal}` : whole);
  };

  const buildReceiveBip21Uri = () => {
    if (!selectedAddress) return '';
    const parsedAmount = Number.parseFloat(bip21Amount);
    const amount =
      Number.isFinite(parsedAmount) && parsedAmount > 0
        ? bip21Amount
        : undefined;

    return buildBip21Uri(selectedAddress, currentNetwork, {
      amount,
      label: bip21Label.trim() || undefined,
      message: bip21Message.trim() || undefined,
    });
  };
  const hasBip21Fields =
    !!bip21Amount.trim() || !!bip21Label.trim() || !!bip21Message.trim();
  const bip21Summary = [
    bip21Amount.trim() ? `Amt ${bip21Amount.trim()} BCH` : '',
    bip21Label.trim() ? 'Label set' : '',
    bip21Message.trim() ? 'Message set' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const keyPairsToDisplay =
    addressType === 'main' ? mainKeyPairs : changeKeyPairs;

  return (
    <div className="container mx-auto max-w-md h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] px-4 pt-4 pb-3 flex flex-col overflow-hidden wallet-page">
      <PageHeader title="Receive" compact />

      {!selectedAddress && (
        <SectionCard className="mb-3">
          <div>
            <div className="flex justify-center space-x-4 mb-4 w-full">
              <button
                className={`flex-1 min-w-[120px] px-4 py-2 font-bold rounded-[14px] text-center ${
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
                className={`flex-1 min-w-[120px] px-4 py-2 font-bold rounded-[14px] text-center ${
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
          </div>
        </SectionCard>
      )}

      <div className="flex flex-col items-center space-y-3 flex-1 min-h-0">
        {!selectedAddress ? (
          <div className="overflow-y-auto font-bold w-full flex-1 min-h-0 rounded-2xl p-1">
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
                      keyPair.address,
                      PREFIX[currentNetwork].length
                    )}
                    <br />
                    {getBchAddressPath(
                      currentNetwork,
                      0,
                      keyPair.changeIndex,
                      keyPair.addressIndex
                    )}
                  </p>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="w-full flex flex-col flex-1 min-h-0">
            <div className="flex flex-col items-center">
              <QRCodeSVG
                value={
                  qrCodeType === 'address'
                    ? buildReceiveBip21Uri()
                    : qrCodeType === 'pubKey'
                      ? selectedPubKey || ''
                      : qrCodeType === 'pkh'
                        ? selectedPKH || ''
                        : selectedPrivKey || ''
                }
                size={200}
              />
              <p
                className="mt-4 p-2.5 wallet-surface-strong rounded-[14px] cursor-pointer hover:brightness-[0.97]"
                onClick={() =>
                  handleCopy(
                    qrCodeType === 'address'
                      ? buildReceiveBip21Uri()
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
            {qrCodeType === 'address' && (
              <div className="mt-3 flex flex-row gap-2 items-center justify-center">
                <span
                  className={
                    isTokenAddress ? 'wallet-muted' : 'wallet-text-strong'
                  }
                >
                  Regular
                </span>
                <div
                  onClick={toggleAddressType}
                  className={`w-12 h-6 rounded-full flex items-center cursor-pointer relative transition-colors duration-300 border border-[var(--wallet-border)] ${
                    isTokenAddress
                      ? 'bg-[var(--wallet-accent)]'
                      : 'wallet-surface-strong'
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
                  className={
                    isTokenAddress ? 'wallet-text-strong' : 'wallet-muted'
                  }
                >
                  CashToken
                </span>
              </div>
            )}

            <div className="flex space-x-4 mt-4 w-full justify-center">
              <button
                className={`px-4 py-2 rounded-[14px] font-bold ${
                  qrCodeType === 'address'
                    ? 'wallet-segment-active'
                    : 'wallet-segment-inactive'
                }`}
                onClick={() => setQrCodeType('address')}
              >
                Address
              </button>
              <button
                className={`px-4 py-2 rounded-[14px] font-bold ${
                  qrCodeType === 'pubKey'
                    ? 'wallet-segment-active'
                    : 'wallet-segment-inactive'
                }`}
                onClick={handlePubKeyTabClick}
              >
                PubKey
              </button>
              <button
                className={`px-4 py-2 rounded-[14px] font-bold ${
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
                  className={`px-4 py-2 rounded-[14px] font-bold ${
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
            <div className="mt-2 min-h-[44px] w-full flex flex-col items-center justify-center gap-1">
              {hasBip21Fields && (
                <p className="text-[11px] wallet-muted text-center px-2">
                  {bip21Summary}
                </p>
              )}
              <button
                className="px-3 py-1 rounded-[14px] text-xs font-semibold wallet-segment-inactive border border-[var(--wallet-border)]"
                onClick={() => setShowBip21Popup(true)}
              >
                BIP21
              </button>
            </div>
            {ALLOW_PRIVATE_KEY_VIEW &&
              !isPrivKeyUnlocked &&
              pubKeyTapCount >= 5 && (
                <div className="wallet-surface-strong mt-2 px-4 py-2 rounded-[14px] text-sm font-bold">
                  PrivKey unlock in {PRIVKEY_UNLOCK_TAPS - pubKeyTapCount} taps
                </div>
              )}

            <div className="mt-auto pt-4">
              <button
                className="wallet-btn-secondary w-full text-xl font-bold"
                onClick={() => {
                  setSelectedAddress(null);
                  setSelectedAddressPair(null);
                  setSelectedPubKey(null);
                  setSelectedPKH(null);
                  setSelectedPrivKey(null);
                  setPubKeyTapCount(0);
                  setIsPrivKeyUnlocked(false);
                  setQrCodeType('address');
                  setShowBip21Popup(false);
                  setBip21Amount('');
                  setBip21Label('');
                  setBip21Message('');
                }}
              >
                Back
              </button>
            </div>
          </div>
        )}
      </div>

      {showBip21Popup && (
        <div
          className="wallet-popup-backdrop"
          onClick={() => setShowBip21Popup(false)}
        >
          <div
            className="wallet-popup-panel w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold mb-3">BIP21 Options</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold wallet-muted mb-1">
                  Amount (BCH)
                </label>
                <input
                  value={bip21Amount}
                  onChange={(e) => handleBip21AmountChange(e.target.value)}
                  inputMode="decimal"
                  placeholder="Optional, e.g. 0.0105"
                  className="w-full px-3 py-2 rounded-[14px] wallet-surface-strong border border-[var(--wallet-border)] outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold wallet-muted mb-1">
                  Label
                </label>
                <input
                  value={bip21Label}
                  onChange={(e) => setBip21Label(e.target.value)}
                  placeholder="Optional"
                  className="w-full px-3 py-2 rounded-[14px] wallet-surface-strong border border-[var(--wallet-border)] outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold wallet-muted mb-1">
                  Message
                </label>
                <input
                  value={bip21Message}
                  onChange={(e) => setBip21Message(e.target.value)}
                  placeholder="Optional"
                  className="w-full px-3 py-2 rounded-[14px] wallet-surface-strong border border-[var(--wallet-border)] outline-none"
                />
              </div>
              <button
                className="wallet-link text-xs underline"
                onClick={() => {
                  setBip21Amount('');
                  setBip21Label('');
                  setBip21Message('');
                }}
              >
                Clear BIP21 fields
              </button>
            </div>
            <div className="mt-4 flex gap-2">
              <button
                className="wallet-btn-secondary flex-1"
                onClick={() => setShowBip21Popup(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Receive;
