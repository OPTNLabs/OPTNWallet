// src/pages/Receive.tsx
import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
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
import SectionHeader from '../components/ui/SectionHeader';
import { zeroize } from '../utils/secureMemory';
import WalletScreen from '../components/ui/WalletScreen';
import Popup from '../components/transaction/Popup';
import type { QuantumrootVaultRecord } from '../types/types';
import UTXOService from '../services/UTXOService';
import { logError } from '../utils/errorHandling';
import {
  summarizeQuantumrootVaultStatus,
  type QuantumrootVaultStatus,
} from '../services/QuantumrootVaultStatusService';
import { getQuantumrootNetworkSupport } from '../services/QuantumrootNetworkSupportService';

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
  const [showAddressListPopup, setShowAddressListPopup] = useState(false);
  const [bip21Amount, setBip21Amount] = useState('');
  const [bip21Label, setBip21Label] = useState('');
  const [bip21Message, setBip21Message] = useState('');
  const [selectedWalletKey, setSelectedWalletKey] = useState<WalletKeyPair | null>(null);
  const [selectedQuantumrootVault, setSelectedQuantumrootVault] =
    useState<QuantumrootVaultRecord | null>(null);
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
          const firstKey = mainKeys[0] ?? changeKeys[0] ?? null;
          if (firstKey) {
            setSelectedWalletKey(firstKey);
            setSelectedAddressPair({
              address: firstKey.address,
              tokenAddress: firstKey.tokenAddress,
            });
            setSelectedAddress(firstKey.address);
            setSelectedPubKey(hexString(firstKey.publicKey));
            setSelectedPKH(hexString(firstKey.pubkeyHash));
            setSelectedPrivKey(null);
          }
        } else {
          console.error('No keys found for the current wallet');
        }
      } catch (error) {
        console.error('Failed to fetch keys:', error);
      }
    };

    fetchKeys();
  }, [currentWalletId]);

  const handleInitializeReceiveAddresses = async () => {
    if (!currentWalletId) return;

    try {
      console.log('[Receive] initializing receive addresses', {
        walletId: currentWalletId,
      });
      await KeyService.bootstrapInitialAddressBatch(currentWalletId, 0, 10);
      const existingKeys = (await KeyService.retrieveKeys(
        currentWalletId
      )) as WalletKeyPair[];
      const mainKeys = existingKeys
        .filter((key) => key.changeIndex === 0)
        .sort((a, b) => a.addressIndex - b.addressIndex);
      const changeKeys = existingKeys
        .filter((key) => key.changeIndex === 1)
        .sort((a, b) => a.addressIndex - b.addressIndex);
      setMainKeyPairs(mainKeys);
      setChangeKeyPairs(changeKeys);
      if (mainKeys.length > 0) {
        const primary = mainKeys[0];
        setSelectedAddressPair({
          address: primary.address,
          tokenAddress: primary.tokenAddress,
        });
        setSelectedAddress(primary.address);
        setSelectedPubKey(hexString(primary.publicKey));
        setSelectedPKH(hexString(primary.pubkeyHash));
      }
      console.log('[Receive] initialization completed', {
        mainKeys: mainKeys.length,
        changeKeys: changeKeys.length,
      });
    } catch (error) {
      logError('Receive.handleInitializeReceiveAddresses', error, {
        walletId: currentWalletId,
      });
    }
  };

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
    setQrCodeType('address');
    setShowBip21Popup(false);
    setShowAddressListPopup(false);
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
      const isSelected = !!selectedAddress;
      const availableHeight = isSelected
        ? viewportHeight * 0.42
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
  }, [selectedAddress]);

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
    const sourcePair = selectedAddressPair ?? primaryKeyPair;
    if (!sourcePair) return;
    const nextIsTokenAddress = !isTokenAddress;
    setIsTokenAddress(nextIsTokenAddress);
    if (!selectedAddressPair && primaryKeyPair) {
      setSelectedAddressPair({
        address: primaryKeyPair.address,
        tokenAddress: primaryKeyPair.tokenAddress,
      });
    }
    setSelectedAddress(
      nextIsTokenAddress
        ? sourcePair.tokenAddress
        : sourcePair.address
    );
  };

  const handleBip21AmountChange = (value: string) => {
    const normalized = value.replace(',', '.').replace(/[^0-9.]/g, '');
    const parts = normalized.split('.');
    const whole = parts[0] || '';
    const decimal = parts.slice(1).join('').slice(0, 8);
    setBip21Amount(parts.length > 1 ? `${whole}.${decimal}` : whole);
  };

  const keyPairsToDisplay =
    addressType === 'main' ? mainKeyPairs : changeKeyPairs;
  const primaryKeyPair = keyPairsToDisplay[0] ?? null;

  const activeAddress =
    selectedAddress ?? primaryKeyPair?.address ?? '';
  const bip21Uri = (() => {
    if (!activeAddress) return '';
    const params = new URLSearchParams();
    const amount = bip21Amount.trim();
    const label = bip21Label.trim();
    const message = bip21Message.trim();
    if (amount) params.set('amount', amount);
    if (label) params.set('label', label);
    if (message) params.set('message', message);
    const query = params.toString();
    return query ? `bitcoincash:${activeAddress}?${query}` : `bitcoincash:${activeAddress}`;
  })();
  const addressPayload = showBip21Popup && bip21Uri ? bip21Uri : activeAddress;
  const activeQrPayload =
    qrCodeType === 'address'
      ? addressPayload
      : qrCodeType === 'pubKey'
        ? selectedPubKey || ''
        : qrCodeType === 'pkh'
          ? selectedPKH || ''
          : selectedPrivKey || '';
  const activeLabel =
    qrCodeType === 'address'
      ? addressPayload
      : qrCodeType === 'pubKey'
        ? selectedPubKey || (primaryKeyPair ? hexString(primaryKeyPair.publicKey) : '')
        : qrCodeType === 'pkh'
          ? selectedPKH || (primaryKeyPair ? hexString(primaryKeyPair.pubkeyHash) : '')
          : selectedPrivKey || '';
  const hasBip21Fields =
    !!bip21Amount.trim() || !!bip21Label.trim() || !!bip21Message.trim();
  const formatQuantumrootBalance = (sats: number) =>
    `${(sats / SATSINBITCOIN).toFixed(8).replace(/\.?0+$/, '') || '0'} BCH`;
  const addressPrefixLength = PREFIX[currentNetwork]?.length ?? PREFIX.mainnet.length;
  const hasReceiveKeys = mainKeyPairs.length > 0 || changeKeyPairs.length > 0;
  const canShowQuantumrootStatus =
    !!selectedQuantumrootVault && quantumrootNetworkSupport.canReceiveOnChain;

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const onError = (event: ErrorEvent) => {
      console.error('[Receive] window error', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error,
      });
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error('[Receive] unhandled rejection', event.reason);
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log('[Receive] state snapshot', {
      currentWalletId,
      currentNetwork,
      addressType,
      selectedAddress,
      selectedAddressPair,
      selectedWalletKey: selectedWalletKey ? selectedWalletKey.address : null,
      mainKeyPairs: mainKeyPairs.length,
      changeKeyPairs: changeKeyPairs.length,
      primaryKeyPair: primaryKeyPair ? primaryKeyPair.address : null,
      selectedQuantumrootVault: selectedQuantumrootVault?.receive_address ?? null,
      quantumrootNetworkSupport,
      canShowQuantumrootStatus,
      activeAddress,
      activeQrPayloadLength: activeQrPayload.length,
      activeLabelLength: activeLabel.length,
    });
  }, [
    activeAddress,
    activeLabel,
    activeQrPayload.length,
    addressType,
    changeKeyPairs.length,
    currentNetwork,
    currentWalletId,
    mainKeyPairs.length,
    canShowQuantumrootStatus,
    quantumrootNetworkSupport,
    selectedAddress,
    selectedAddressPair,
    selectedQuantumrootVault,
    selectedWalletKey,
    primaryKeyPair,
  ]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    console.log('[Receive] render branch', {
      hasSelectedAddress: !!selectedAddress,
      keyPairsToDisplay: keyPairsToDisplay.length,
      isTokenAddress,
      qrCodeType,
      showAddressListPopup,
    });
  }, [
    isTokenAddress,
    keyPairsToDisplay.length,
    qrCodeType,
    selectedAddress,
    showAddressListPopup,
  ]);

  const renderAddressTypeToggle = () => {
    return (
      <div className="mt-3 flex items-center justify-center gap-2">
        <span className={isTokenAddress ? 'wallet-muted' : 'wallet-text-strong'}>
          Regular
        </span>
        <button
          type="button"
          onClick={toggleAddressType}
          className={`relative flex h-6 w-12 items-center rounded-full border border-[var(--wallet-border)] transition-colors duration-300 ${
            isTokenAddress ? 'bg-[var(--wallet-accent)]' : 'wallet-surface-strong'
          }`}
          aria-label="Toggle receive address type"
        >
          <span
            className={`h-6 w-6 rounded-full shadow-md transition-transform duration-300 ${
              isTokenAddress ? 'translate-x-6' : 'translate-x-0'
            }`}
            style={{ backgroundColor: 'var(--wallet-card-bg)' }}
          />
        </button>
        <span className={isTokenAddress ? 'wallet-text-strong' : 'wallet-muted'}>
          CashToken
        </span>
      </div>
    );
  };

  const renderReceiveContent = () => {
    if (!hasReceiveKeys) {
      return (
        <SectionCard className="p-4">
          <SectionHeader
            title="Receive addresses not ready"
            subtitle="Prepare addresses to show your receive QR and address list."
            compact
          />
          <div className="space-y-3">
            <EmptyState message="This wallet does not have receive addresses loaded yet." />
            <button
              type="button"
              className="wallet-btn-secondary w-full"
              onClick={() => void handleInitializeReceiveAddresses()}
            >
              Prepare receive addresses
            </button>
          </div>
        </SectionCard>
      );
    }

    const qrSection = (
      <SectionCard className="p-3">
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-2xl border border-[rgba(0,0,0,0.08)] bg-white p-1 shadow-sm">
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
          <button
            type="button"
            className="wallet-surface-strong rounded-[14px] p-2.5 hover:brightness-[0.97]"
            onClick={() => handleCopy(activeQrPayload)}
          >
            {shortenTxHash(activeLabel, addressPrefixLength)}
          </button>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              className={`wallet-btn-secondary px-3 py-1.5 text-xs ${
                addressType === 'main' ? 'wallet-segment-active' : ''
              }`}
              onClick={() => setAddressType('main')}
            >
              Main
            </button>
            <button
              type="button"
              className={`wallet-btn-secondary px-3 py-1.5 text-xs ${
                addressType === 'change' ? 'wallet-segment-active' : ''
              }`}
              onClick={() => setAddressType('change')}
            >
              Change
            </button>
            <button
              type="button"
              className={`wallet-btn-secondary px-3 py-1.5 text-xs ${
                showBip21Popup ? 'wallet-segment-active' : ''
              }`}
              onClick={() => setShowBip21Popup(true)}
            >
              BIP21
            </button>
          </div>
          {renderAddressTypeToggle()}
        </div>
      </SectionCard>
    );

    const addressBrowser = (
      <SectionCard className="p-3">
        <div className="flex items-center justify-between gap-3">
          <SectionHeader
            title="Show more addresses"
            subtitle={`${keyPairsToDisplay.length} ${addressType} addresses`}
            compact
          />
          <button
            type="button"
            className="wallet-btn-secondary px-3 py-1.5 text-xs"
            onClick={() => setShowAddressListPopup(true)}
          >
            OPTN
          </button>
        </div>
      </SectionCard>
    );

    const modeButtons = (
      <SectionCard className="p-3">
        <div className="flex flex-wrap justify-center gap-2">
          <button
            type="button"
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
            type="button"
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
            type="button"
            className={`px-4 py-2 rounded-[14px] font-bold ${
              qrCodeType === 'pkh'
                ? 'wallet-segment-active'
                : 'wallet-segment-inactive'
            }`}
            onClick={() => setQrCodeType('pkh')}
          >
            PKH
          </button>
        </div>
        {isPrivKeyUnlocked && (
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              className={`px-4 py-2 rounded-[14px] font-bold ${
                qrCodeType === 'privkey'
                  ? 'wallet-segment-active'
                  : 'wallet-segment-inactive'
              }`}
              onClick={() => setQrCodeType('privkey')}
            >
              PrivKey
            </button>
          </div>
        )}
        {ALLOW_PRIVATE_KEY_VIEW &&
          !isPrivKeyUnlocked &&
          pubKeyTapCount >= 5 && (
            <div className="wallet-surface-strong mt-2 rounded-[14px] px-4 py-2 text-sm font-bold">
              PrivKey unlock in {PRIVKEY_UNLOCK_TAPS - pubKeyTapCount} taps
            </div>
          )}
      </SectionCard>
    );

    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 pb-[calc(var(--safe-bottom)+1rem)]">
        {addressBrowser}
        {qrSection}
        {modeButtons}
        {!selectedAddress && (
          <SectionCard className="p-4">
            <SectionHeader
              title="Receive addresses not ready"
              subtitle="Prepare addresses to show your receive QR and address list."
              compact
            />
            <div className="mt-3 space-y-3">
              <EmptyState message="This wallet does not have receive addresses loaded yet." />
              <button
                type="button"
                className="wallet-btn-secondary w-full"
                onClick={() => void handleInitializeReceiveAddresses()}
              >
                Prepare receive addresses
              </button>
            </div>
          </SectionCard>
        )}
      </div>
    );
  };

  return (
    <WalletScreen maxWidthClassName="max-w-md">
      <div className="flex min-h-0 flex-col gap-4">
        <PageHeader
          title="Receive"
          compact
        />

        {renderReceiveContent()}
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
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-lg font-bold">Quantumroot Status</h3>
              {loadingQuantumrootStatus && (
                <span className="text-xs wallet-muted">Syncing…</span>
              )}
            </div>
            <p className="mb-3 text-xs wallet-muted">
              This view is read-only. It shows vault status and key receive data,
              but no spending or recovery actions.
            </p>
            {quantumrootStatus ? (
              <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <div className="wallet-surface-strong rounded-[14px] p-3">
                    <div className="mb-1 text-[11px] font-semibold wallet-muted">
                      Receive Balance
                    </div>
                    <div className="font-bold">
                      {formatQuantumrootBalance(
                        quantumrootStatus.receiveBalanceSats
                      )}
                    </div>
                    <div className="mt-1 text-[11px] wallet-muted">
                      {quantumrootStatus.receiveUtxoCount} UTXOs
                    </div>
                  </div>
                  <div className="wallet-surface-strong rounded-[14px] p-3">
                    <div className="mb-1 text-[11px] font-semibold wallet-muted">
                      Quantum Lock
                    </div>
                    <div className="font-bold">
                      {formatQuantumrootBalance(
                        quantumrootStatus.quantumLockBalanceSats
                      )}
                    </div>
                    <div className="mt-1 text-[11px] wallet-muted">
                      {quantumrootStatus.quantumLockUtxoCount} UTXOs
                    </div>
                  </div>
                </div>
                <div className="wallet-surface-strong rounded-[14px] p-3">
                  <div className="mb-1 text-[11px] font-semibold wallet-muted">
                    Receive Address
                  </div>
                  <div className="break-all font-mono text-xs">
                    {selectedQuantumrootVault?.receive_address ?? 'Unavailable'}
                  </div>
                </div>
                <div className="wallet-surface-strong rounded-[14px] p-3">
                  <div className="mb-1 text-[11px] font-semibold wallet-muted">
                    Quantum Lock Address
                  </div>
                  <div className="break-all font-mono text-xs">
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
                type="button"
                className="wallet-btn-secondary flex-1"
                onClick={() => setShowQuantumrootStatusPopup(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showBip21Popup && (
        <Popup closePopups={() => setShowBip21Popup(false)} closeButtonText="Done">
          <SectionHeader
            title="BIP21 payment request"
            subtitle="Encode amount, label, and message into the QR payload."
            compact
          />
          <div className="mt-3 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold wallet-muted">
                Amount (BCH)
              </label>
              <input
                value={bip21Amount}
                onChange={(e) => handleBip21AmountChange(e.target.value)}
                inputMode="decimal"
                placeholder="Optional, e.g. 0.0105"
                className="w-full rounded-[14px] border border-[var(--wallet-border)] bg-transparent px-3 py-2 outline-none wallet-surface-strong"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold wallet-muted">
                Label
              </label>
              <input
                value={bip21Label}
                onChange={(e) => setBip21Label(e.target.value)}
                placeholder="Optional"
                className="w-full rounded-[14px] border border-[var(--wallet-border)] bg-transparent px-3 py-2 outline-none wallet-surface-strong"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold wallet-muted">
                Message
              </label>
              <input
                value={bip21Message}
                onChange={(e) => setBip21Message(e.target.value)}
                placeholder="Optional"
                className="w-full rounded-[14px] border border-[var(--wallet-border)] bg-transparent px-3 py-2 outline-none wallet-surface-strong"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="wallet-btn-secondary px-3 py-1.5 text-xs"
                onClick={() => void handleCopy(bip21Uri || activeAddress)}
              >
                Copy BIP21 URI
              </button>
              <button
                type="button"
                className="wallet-link text-xs underline"
                onClick={() => {
                  setBip21Amount('');
                  setBip21Label('');
                  setBip21Message('');
                }}
              >
                Clear
              </button>
            </div>
            <p className="text-[11px] wallet-muted">
              When enabled, the QR and copied payload use a BIP21-style
              `bitcoincash:` URI so compatible wallets can autofill request details.
            </p>
            {hasBip21Fields && (
              <p className="text-[11px] wallet-muted">
                Request details are active and the QR is now encoding the BIP21 URI.
              </p>
            )}
          </div>
        </Popup>
      )}

      {showAddressListPopup && (
        <Popup
          closePopups={() => setShowAddressListPopup(false)}
          closeButtonText="Close"
        >
          <SectionHeader
            title="See all addresses"
            subtitle={`${keyPairsToDisplay.length} ${addressType} addresses`}
            compact
          />
          <div className="mt-3 flex items-center justify-center gap-2">
            <button
              type="button"
              className={`wallet-btn-secondary px-3 py-1.5 text-xs ${
                addressType === 'main' ? 'wallet-segment-active' : ''
              }`}
              onClick={() => setAddressType('main')}
            >
              Main
            </button>
            <button
              type="button"
              className={`wallet-btn-secondary px-3 py-1.5 text-xs ${
                addressType === 'change' ? 'wallet-segment-active' : ''
              }`}
              onClick={() => setAddressType('change')}
            >
              Change
            </button>
          </div>
          <div className="mt-3 max-h-[60vh] space-y-2 overflow-y-auto overscroll-contain pr-1">
            {keyPairsToDisplay.length > 0 ? (
              keyPairsToDisplay.map((keyPair, index: number) => {
                const displayAddress = keyPair.address;
                const path = getBchAddressPath(
                  currentNetwork,
                  0,
                  keyPair.changeIndex,
                  keyPair.addressIndex
                );
                return (
                  <div
                    key={`${keyPair.changeIndex}:${keyPair.addressIndex}`}
                    className="wallet-card p-0 overflow-hidden"
                  >
                    <button
                      type="button"
                      className="w-full p-3 text-left"
                      onClick={() => {
                        void handleAddressSelect(keyPair.tokenAddress, displayAddress);
                        setShowAddressListPopup(false);
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold wallet-text-strong">
                            {shortenTxHash(displayAddress, addressPrefixLength)}
                          </div>
                          <div className="mt-1 break-all text-xs wallet-muted">
                            {path}
                          </div>
                        </div>
                        <div className="shrink-0 text-[11px] font-semibold wallet-muted">
                          #{index + 1}
                        </div>
                      </div>
                    </button>
                  </div>
                );
              })
            ) : (
              <EmptyState message="No addresses found in this branch yet." />
            )}
          </div>
        </Popup>
      )}
    </WalletScreen>
  );
};

export default Receive;
