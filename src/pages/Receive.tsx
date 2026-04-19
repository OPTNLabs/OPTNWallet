// src/pages/Receive.tsx
import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { RootState } from '../redux/store';
import KeyService from '../services/KeyService';
import { Toast } from '@capacitor/toast';
import { shortenTxHash } from '../utils/shortenHash';
import { PREFIX, SATSINBITCOIN } from '../utils/constants';
import { getBchAddressPath } from '../services/HdWalletService';
import { selectCurrentNetwork } from '../redux/selectors/networkSelectors';
import { QRCodeSVG } from 'qrcode.react';
import { hexString } from '../utils/hex';
import { encodePrivateKeyWif } from '@bitauth/libauth';
import { Network } from '../redux/networkSlice';
import PageHeader from '../components/ui/PageHeader';
import SectionCard from '../components/ui/SectionCard';
import EmptyState from '../components/ui/EmptyState';
import { zeroize } from '../utils/secureMemory';
import type { QuantumrootVaultRecord } from '../types/types';
import UTXOService from '../services/UTXOService';
import {
  summarizeQuantumrootVaultStatus,
  type QuantumrootVaultStatus,
} from '../services/QuantumrootVaultStatusService';
import { getQuantumrootNetworkSupport } from '../services/QuantumrootNetworkSupportService';

type QRCodeType = 'address' | 'pubKey' | 'pkh' | 'privkey';
type ReceiveMode = 'standard' | 'quantumroot';
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
  const navigate = useNavigate();
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
  const [showQuantumrootPopup, setShowQuantumrootPopup] = useState(false);
  const [receiveMode, setReceiveMode] = useState<ReceiveMode>('standard');
  const [bip21Amount, setBip21Amount] = useState('');
  const [bip21Label, setBip21Label] = useState('');
  const [bip21Message, setBip21Message] = useState('');
  const [selectedWalletKey, setSelectedWalletKey] = useState<WalletKeyPair | null>(null);
  const [selectedQuantumrootVault, setSelectedQuantumrootVault] =
    useState<QuantumrootVaultRecord | null>(null);
  const [loadingQuantumrootVault, setLoadingQuantumrootVault] = useState(false);
  const [showQuantumrootStatusPopup, setShowQuantumrootStatusPopup] =
    useState(false);
  const [quantumrootStatus, setQuantumrootStatus] = useState<QuantumrootVaultStatus | null>(
    null
  );
  const [loadingQuantumrootStatus, setLoadingQuantumrootStatus] = useState(false);
  const [qrCodeSize, setQrCodeSize] = useState(200);

  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const quantumrootNetworkSupport = getQuantumrootNetworkSupport(currentNetwork);
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
    setSelectedWalletKey(selectedKey);
    setSelectedQuantumrootVault(null);
    setSelectedAddressPair({ address, tokenAddress });
    setSelectedAddress(address);
    setSelectedPubKey(pubkey);
    setSelectedPKH(pkh);
    setSelectedPrivKey(wif);
    setIsTokenAddress(false);
    setReceiveMode('standard');
    setQrCodeType('address');
    setShowBip21Popup(false);
    setShowQuantumrootPopup(false);
    setShowQuantumrootStatusPopup(false);
    setQuantumrootStatus(null);
    setBip21Amount('');
    setBip21Label('');
    setBip21Message('');
  };

  useEffect(() => {
    if (!currentWalletId || !selectedWalletKey) return;

    let cancelled = false;
    const loadQuantumrootVault = async () => {
      setLoadingQuantumrootVault(true);
      try {
        const vault = await KeyService.createQuantumrootVault(
          currentWalletId,
          selectedWalletKey.addressIndex,
          0
        );
        if (!cancelled) {
          setSelectedQuantumrootVault(vault);
        }
      } catch (error) {
        console.error('Failed to derive Quantumroot vault:', error);
        if (!cancelled) {
          setSelectedQuantumrootVault(null);
        }
      } finally {
        if (!cancelled) {
          setLoadingQuantumrootVault(false);
        }
      }
    };

    void loadQuantumrootVault();

    return () => {
      cancelled = true;
    };
  }, [currentWalletId, selectedWalletKey]);

  useEffect(() => {
    if (!currentWalletId || !selectedQuantumrootVault) return;

    let cancelled = false;
    const loadQuantumrootStatus = async () => {
      setLoadingQuantumrootStatus(true);
      try {
        const [receiveUtxos, quantumLockUtxos] = await Promise.all([
          UTXOService.fetchAndStoreUTXOs(
            currentWalletId,
            selectedQuantumrootVault.receive_address
          ),
          UTXOService.fetchAndStoreUTXOs(
            currentWalletId,
            selectedQuantumrootVault.quantum_lock_address
          ),
        ]);
        if (!cancelled) {
          setQuantumrootStatus(
            summarizeQuantumrootVaultStatus(receiveUtxos, quantumLockUtxos)
          );
        }
      } catch (error) {
        console.error('Failed to load Quantumroot vault status:', error);
        if (!cancelled) {
          setQuantumrootStatus(null);
        }
      } finally {
        if (!cancelled) {
          setLoadingQuantumrootStatus(false);
        }
      }
    };

    void loadQuantumrootStatus();

    return () => {
      cancelled = true;
    };
  }, [currentWalletId, selectedQuantumrootVault]);

  useEffect(() => {
    const updateQrSize = () => {
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const isQuantumroot = receiveMode === 'quantumroot';
      const isSelected = !!selectedAddress;
      const availableHeight = isSelected
        ? isQuantumroot
          ? viewportHeight * 0.34
          : viewportHeight * 0.42
        : viewportHeight * 0.22;
      const availableWidth = viewportWidth * 0.68;
      const nextSize = Math.floor(Math.min(availableHeight, availableWidth));
      setQrCodeSize(Math.max(136, Math.min(200, nextSize)));
    };

    updateQrSize();
    window.visualViewport?.addEventListener('resize', updateQrSize);
    window.addEventListener('resize', updateQrSize);
    return () => {
      window.visualViewport?.removeEventListener('resize', updateQrSize);
      window.removeEventListener('resize', updateQrSize);
    };
  }, [receiveMode, selectedAddress]);

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

  const activeAddress =
    receiveMode === 'quantumroot'
      ? selectedQuantumrootVault?.receive_address ?? ''
      : selectedAddress ?? '';
  const activeQrPayload =
    qrCodeType === 'address'
      ? activeAddress
      : qrCodeType === 'pubKey'
        ? selectedPubKey || ''
        : qrCodeType === 'pkh'
          ? selectedPKH || ''
          : selectedPrivKey || '';
  const activeLabel =
    qrCodeType === 'address'
      ? activeAddress
      : qrCodeType === 'pubKey'
        ? selectedPubKey || ''
        : qrCodeType === 'pkh'
          ? selectedPKH || ''
          : selectedPrivKey || '';
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

  const formatQuantumrootBalance = (sats: number) =>
    `${(sats / SATSINBITCOIN).toFixed(8).replace(/\.?0+$/, '') || '0'} BCH`;
  const showStandardActions = receiveMode === 'standard';
  const showQuantumrootActions = receiveMode === 'quantumroot';

  return (
    <div className="container mx-auto max-w-md h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] px-4 pt-4 pb-[calc(var(--safe-bottom)+1rem)] flex flex-col overflow-hidden wallet-page">
      <PageHeader
        title="Receive"
        compact
      />

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
              <div className="mb-3 flex gap-2">
                <button
                  className={`px-4 py-2 rounded-[14px] text-sm font-bold ${
                    receiveMode === 'standard'
                      ? 'wallet-segment-active'
                      : 'wallet-segment-inactive'
                  }`}
                  onClick={() => setReceiveMode('standard')}
                >
                  Standard
                </button>
              <button
                className={`px-4 py-2 rounded-[14px] text-sm font-bold ${
                  receiveMode === 'quantumroot'
                      ? 'wallet-segment-active'
                      : 'wallet-segment-inactive'
                  }`}
                  onClick={() => {
                    setReceiveMode('quantumroot');
                    setQrCodeType('address');
                    setIsTokenAddress(false);
                  }}
                  disabled={
                    !selectedQuantumrootVault || !quantumrootNetworkSupport.canReceiveOnChain
                  }
                >
                  {quantumrootNetworkSupport.isPreviewOnly
                    ? 'Quantumroot Preview'
                    : 'Quantumroot'}
                </button>
              </div>
              {quantumrootNetworkSupport.isPreviewOnly && (
                <p className="text-xs wallet-muted text-center px-4 mb-3">
                  Quantumroot is visible on mainnet for preview, but receive and
                  recovery remain disabled until the May 15, 2026 network upgrade.
                </p>
              )}
              <div className="rounded-2xl bg-white p-1 shadow-sm border border-[rgba(0,0,0,0.08)]">
                <QRCodeSVG
                  value={activeQrPayload}
                  size={qrCodeSize}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="H"
                  marginSize={1}
                  imageSettings={{
                    src: '/assets/images/OPTNUIkeyline.png',
                    height: 36,
                    width: 36,
                    excavate: true,
                  }}
                />
              </div>
              <p
                className="mt-4 p-2.5 wallet-surface-strong rounded-[14px] cursor-pointer hover:brightness-[0.97]"
                onClick={() => handleCopy(activeQrPayload)}
              >
                {shortenTxHash(activeLabel, PREFIX[currentNetwork].length)}
              </p>
            </div>
            {qrCodeType === 'address' && receiveMode === 'standard' && (
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
              {showStandardActions && (
                <>
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
                </>
              )}
              {showStandardActions && isPrivKeyUnlocked && (
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
                {showStandardActions && hasBip21Fields && (
                  <p className="text-[11px] wallet-muted text-center px-2">
                  {bip21Summary}
                </p>
              )}
              <div className="flex gap-2">
                {showStandardActions && qrCodeType === 'address' && (
                  <button
                    className="px-3 py-1 rounded-[14px] text-xs font-semibold wallet-segment-inactive border border-[var(--wallet-border)] opacity-50 cursor-not-allowed"
                    onClick={() => undefined}
                    disabled
                  >
                    BIP21
                  </button>
                )}
                {showQuantumrootActions && (
                  <>
                    <button
                      className="px-3 py-1 rounded-[14px] text-xs font-semibold wallet-segment-inactive border border-[var(--wallet-border)]"
                      onClick={() => setShowQuantumrootPopup(true)}
                    >
                      Vault Details
                    </button>
                    <button
                      className="px-3 py-1 rounded-[14px] text-xs font-semibold wallet-segment-inactive border border-[var(--wallet-border)]"
                      onClick={() => navigate('/quantumroot')}
                    >
                      Workspace
                    </button>
                  </>
                )}
              </div>
            </div>
            {ALLOW_PRIVATE_KEY_VIEW &&
              receiveMode === 'standard' &&
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
                  setSelectedWalletKey(null);
                  setSelectedQuantumrootVault(null);
                  setQuantumrootStatus(null);
                  setPubKeyTapCount(0);
                  setIsPrivKeyUnlocked(false);
                  setReceiveMode('standard');
                  setQrCodeType('address');
                  setShowBip21Popup(false);
                  setShowQuantumrootPopup(false);
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

      {showQuantumrootStatusPopup && (
        <div
          className="wallet-popup-backdrop"
          onClick={() => setShowQuantumrootStatusPopup(false)}
        >
          <div
            className="wallet-popup-panel w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 mb-2">
              <h3 className="text-lg font-bold">Quantumroot Status</h3>
              {loadingQuantumrootStatus && (
                <span className="text-xs wallet-muted">Syncing…</span>
              )}
            </div>
            <p className="text-xs wallet-muted mb-3">
              This view is read-only. It shows vault status and key receive data,
              but no spending or recovery actions.
            </p>
            {quantumrootStatus ? (
              <div className="space-y-3 text-sm max-h-[60vh] overflow-y-auto pr-1">
                <div className="grid grid-cols-2 gap-2">
                  <div className="wallet-surface-strong rounded-[14px] p-3">
                    <div className="text-[11px] font-semibold wallet-muted mb-1">
                      Receive Balance
                    </div>
                    <div className="font-bold">
                      {formatQuantumrootBalance(
                        quantumrootStatus.receiveBalanceSats
                      )}
                    </div>
                    <div className="text-[11px] wallet-muted mt-1">
                      {quantumrootStatus.receiveUtxoCount} UTXOs
                    </div>
                  </div>
                  <div className="wallet-surface-strong rounded-[14px] p-3">
                    <div className="text-[11px] font-semibold wallet-muted mb-1">
                      Quantum Lock
                    </div>
                    <div className="font-bold">
                      {formatQuantumrootBalance(
                        quantumrootStatus.quantumLockBalanceSats
                      )}
                    </div>
                    <div className="text-[11px] wallet-muted mt-1">
                      {quantumrootStatus.quantumLockUtxoCount} UTXOs
                    </div>
                  </div>
                </div>
                <div className="wallet-surface-strong rounded-[14px] p-3">
                  <div className="text-[11px] font-semibold wallet-muted mb-1">
                    Receive Address
                  </div>
                  <div className="font-mono text-xs break-all">
                    {selectedQuantumrootVault?.receive_address ?? 'Unavailable'}
                  </div>
                </div>
                <div className="wallet-surface-strong rounded-[14px] p-3">
                  <div className="text-[11px] font-semibold wallet-muted mb-1">
                    Quantum Lock Address
                  </div>
                  <div className="font-mono text-xs break-all">
                    {selectedQuantumrootVault?.quantum_lock_address ?? 'Unavailable'}
                  </div>
                </div>
              </div>
            ) : (
              !loadingQuantumrootStatus && (
                <p className="text-sm wallet-muted">
                  No Quantumroot vault funds detected yet.
                </p>
              )
            )}
            <div className="mt-4 flex gap-2">
              <button
                className="wallet-btn-secondary flex-1"
                onClick={() => setShowQuantumrootStatusPopup(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showBip21Popup && false && (
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
      {showQuantumrootPopup && (
        <div
          className="wallet-popup-backdrop"
          onClick={() => setShowQuantumrootPopup(false)}
        >
          <div
            className="wallet-popup-panel w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 mb-2">
              <h3 className="text-lg font-bold">Quantumroot Vault</h3>
              {loadingQuantumrootVault && (
                <span className="text-xs wallet-muted">Deriving…</span>
              )}
            </div>
            {selectedWalletKey && (
              <p className="text-[11px] wallet-muted mb-3">
                Dedicated vault for address index {selectedWalletKey.addressIndex}
              </p>
            )}
            {!loadingQuantumrootVault && !selectedQuantumrootVault && (
              <p className="text-sm wallet-muted">
                Quantumroot vault unavailable for this address.
              </p>
            )}
            {selectedQuantumrootVault && (
              <div className="space-y-3 max-h-[60vh] overflow-y-auto">
                <div className="wallet-surface-strong rounded-[14px] p-3">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <h4 className="text-sm font-bold">Quantumroot Status</h4>
                    {loadingQuantumrootStatus && (
                      <span className="text-xs wallet-muted">Syncing…</span>
                    )}
                  </div>
                  <p className="text-xs wallet-muted mb-3">
                    Read-only receive status for this vault. No spending or recovery is available from Receive.
                  </p>
                  {quantumrootStatus ? (
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="wallet-surface-strong rounded-[14px] p-3">
                        <div className="text-[11px] font-semibold wallet-muted mb-1">
                          Receive Balance
                        </div>
                        <div className="font-bold">
                          {formatQuantumrootBalance(
                            quantumrootStatus.receiveBalanceSats
                          )}
                        </div>
                        <div className="text-[11px] wallet-muted mt-1">
                          {quantumrootStatus.receiveUtxoCount} UTXOs
                        </div>
                      </div>
                      <div className="wallet-surface-strong rounded-[14px] p-3">
                        <div className="text-[11px] font-semibold wallet-muted mb-1">
                          Quantum Lock
                        </div>
                        <div className="font-bold">
                          {formatQuantumrootBalance(
                            quantumrootStatus.quantumLockBalanceSats
                          )}
                        </div>
                        <div className="text-[11px] wallet-muted mt-1">
                          {quantumrootStatus.quantumLockUtxoCount} UTXOs
                        </div>
                      </div>
                    </div>
                  ) : (
                    !loadingQuantumrootStatus && (
                      <p className="text-sm wallet-muted">
                        No Quantumroot vault funds detected yet.
                      </p>
                    )
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold wallet-muted mb-1">
                    Receive Address
                  </label>
                  <button
                    className="w-full text-left text-sm wallet-text-strong break-all"
                    onClick={() =>
                      handleCopy(selectedQuantumrootVault.receive_address ?? '')
                    }
                  >
                    {selectedQuantumrootVault.receive_address ?? 'Unavailable'}
                  </button>
                </div>
                <div>
                  <label className="block text-xs font-semibold wallet-muted mb-1">
                    Quantum Lock
                  </label>
                  <button
                    className="w-full text-left text-sm wallet-text-strong break-all"
                    onClick={() =>
                      handleCopy(selectedQuantumrootVault.quantum_lock_address ?? '')
                    }
                  >
                    {selectedQuantumrootVault.quantum_lock_address ?? 'Unavailable'}
                  </button>
                </div>
                <div>
                  <label className="block text-xs font-semibold wallet-muted mb-1">
                    Quantum Public Key
                  </label>
                  <button
                    className="w-full text-left text-xs wallet-text-strong break-all"
                    onClick={() =>
                      handleCopy(selectedQuantumrootVault.quantum_public_key ?? '')
                    }
                  >
                    {selectedQuantumrootVault.quantum_public_key ?? 'Unavailable'}
                  </button>
                </div>
                <div>
                  <label className="block text-xs font-semibold wallet-muted mb-1">
                    Key Identifier
                  </label>
                  <button
                    className="w-full text-left text-xs wallet-text-strong break-all"
                    onClick={() =>
                      handleCopy(selectedQuantumrootVault.quantum_key_identifier ?? '')
                    }
                  >
                    {selectedQuantumrootVault.quantum_key_identifier ?? 'Unavailable'}
                  </button>
                </div>
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <button
                className="wallet-btn-secondary flex-1"
                onClick={() => setShowQuantumrootPopup(false)}
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
