// src/pages/Receive.tsx
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { RootState } from '../state/store';
import KeyService from '../services/KeyService';
import { Toast } from '@capacitor/toast';
import { shortenTxHash } from '../utils/shortenHash';
import { PREFIX, SATSINBITCOIN } from '../utils/constants';
import { getBchAddressPath } from '../services/HdWalletService';
import { selectCurrentNetwork } from '../state/selectors/networkSelectors';
import { selectWalletDerivationPath } from '../state/slices/walletSlice';
import { QRCodeSVG } from 'qrcode.react';
import { hexString } from '../utils/hex';
import { encodePrivateKeyWif } from '@bitauth/libauth';
import { Network } from '../state/slices/networkSlice';
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
import { getReturnPath } from '../utils/navigation';
import { RpaReceiveCard } from '../features/rpa/RpaReceiveCard';
import { isDesktopPlatform } from '../utils/platform';
import { WalletType } from '../types/wallet';
import { useI18n } from '../i18n/useI18n';
import { copyToClipboard } from '../utils/clipboard';
import { canSignLocally } from '../services/watchOnlyWallet';

type QRCodeType = 'address' | 'pubKey' | 'pkh' | 'privkey';
const PRIVKEY_UNLOCK_TAPS = 10;
const ALLOW_PRIVATE_KEY_VIEW = true;

type WalletKeyPair = {
  address: string;
  tokenAddress: string;
  publicKey: Uint8Array;
  pubkeyHash: Uint8Array;
  changeIndex: number;
  addressIndex: number;
};

async function fetchAddressWif(
  address: string,
  currentNetwork: Network
): Promise<string | null> {
  if (!ALLOW_PRIVATE_KEY_VIEW) return null;
  let privateKey: Uint8Array | null = null;
  try {
    // 'reveal': this hands the raw key to the user as WIF. Electron Cash gates
    // the equivalent (show_private_key / export_privkeys_dialog) behind
    // @protected, so it re-prompts for the wallet password. The tap-count
    // unlock below is discoverability, not authentication.
    privateKey = await KeyService.fetchAddressPrivateKey(address, 'reveal');
    if (!privateKey) return null;
    return encodePrivateKeyWif(
      privateKey,
      currentNetwork === Network.MAINNET ? 'mainnet' : 'testnet'
    );
  } catch (error) {
    console.warn('[Receive] failed to load private key WIF', {
      address,
      error,
    });
    return null;
  } finally {
    if (privateKey) {
      zeroize(privateKey);
    }
  }
}

function renderMaskedLabel(
  value: string,
  prefixLength = 7,
  suffixLength = 7
): React.ReactNode {
  if (!value) return null;
  if (value.length <= prefixLength + suffixLength + 1) {
    return <span className="block min-w-0 truncate">{value}</span>;
  }

  const maskedLength = Math.max(8, value.length - prefixLength - suffixLength);
  return (
    <span className="flex min-w-0 items-center overflow-hidden whitespace-nowrap font-mono text-sm">
      <span className="shrink-0">{value.slice(0, prefixLength)}</span>
      <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap px-0.5 text-center tracking-[0.18em]">
        {'*'.repeat(maskedLength)}
      </span>
      <span className="shrink-0">{value.slice(-suffixLength)}</span>
    </span>
  );
}

const Receive: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useI18n();
  const location = useLocation();
  const backTarget = getReturnPath(location, '/apps');
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
  const [showQrPopup, setShowQrPopup] = useState(false);
  const [bip21Amount, setBip21Amount] = useState('');
  const [bip21Label, setBip21Label] = useState('');
  const [bip21Message, setBip21Message] = useState('');
  const [selectedWalletKey, setSelectedWalletKey] =
    useState<WalletKeyPair | null>(null);
  const [selectedQuantumrootVault, setSelectedQuantumrootVault] =
    useState<QuantumrootVaultRecord | null>(null);
  const [showQuantumrootStatusPopup, setShowQuantumrootStatusPopup] =
    useState(false);
  const [quantumrootStatus, setQuantumrootStatus] =
    useState<QuantumrootVaultStatus | null>(null);
  const [loadingQuantumrootStatus, setLoadingQuantumrootStatus] =
    useState(false);
  const [privKeyUnlockToastVisible, setPrivKeyUnlockToastVisible] =
    useState(false);
  const [privKeyUnlockToastMessage, setPrivKeyUnlockToastMessage] =
    useState('');
  const [qrCodeSize, setQrCodeSize] = useState(180);
  const [searchParams] = useSearchParams();
  const receiveHeaderRef = useRef<HTMLDivElement | null>(null);
  const addressBrowserRef = useRef<HTMLDivElement | null>(null);
  const addressTypeToggleRef = useRef<HTMLDivElement | null>(null);
  const qrMetaRef = useRef<HTMLDivElement | null>(null);
  const receiveBodyRef = useRef<HTMLDivElement | null>(null);
  const modeTabsScrollRef = useRef<HTMLDivElement | null>(null);
  const privkeyTabRef = useRef<HTMLButtonElement | null>(null);

  const currentWalletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const walletType = useSelector(
    (state: RootState) => state.wallet_id.walletType
  );
  const canRevealPrivateKey =
    ALLOW_PRIVATE_KEY_VIEW && canSignLocally(walletType);
  const currentNetwork = useSelector((state: RootState) =>
    selectCurrentNetwork(state)
  );
  const derivationPath = useSelector(selectWalletDerivationPath);
  const quantumrootNetworkSupport =
    getQuantumrootNetworkSupport(currentNetwork);
  const wallet_id = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );

  useEffect(() => {
    const fetchKeys = async () => {
      if (!currentWalletId) return;

      try {
        let existingKeys = (await KeyService.retrieveKeys(
          currentWalletId
        )) as WalletKeyPair[];

        // A desktop wallet can reach this shared screen from a restored
        // session before the landing-page bootstrap has completed. Repair only
        // standard Tauri wallets here; mobile has its own onboarding bootstrap,
        // and public-key wallet types must never attempt mnemonic derivation.
        if (
          existingKeys.length === 0 &&
          isDesktopPlatform() &&
          walletType === WalletType.STANDARD
        ) {
          await KeyService.bootstrapInitialAddressBatch(currentWalletId, 0, 20);
          existingKeys = (await KeyService.retrieveKeys(
            currentWalletId
          )) as WalletKeyPair[];
        }

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
            // Do NOT load WIF here — that is a 'reveal' and re-prompts the wallet
            // password. Receive only needs addresses/pubkeys; private key is
            // fetched when the user deliberately unlocks the privkey view.
            setSelectedWalletKey(firstKey);
            setSelectedAddressPair({
              address: firstKey.address,
              tokenAddress: firstKey.tokenAddress,
            });
            setSelectedAddress(firstKey.address);
            setSelectedPubKey(hexString(firstKey.publicKey));
            setSelectedPKH(hexString(firstKey.pubkeyHash));
            setSelectedPrivKey(null);
            setIsPrivKeyUnlocked(false);
            setPubKeyTapCount(0);
          }
        } else {
          console.error('No keys found for the current wallet');
        }
      } catch (error) {
        console.error('Failed to fetch keys:', error);
      }
    };

    fetchKeys();
  }, [currentWalletId, currentNetwork, walletType]);

  const handleInitializeReceiveAddresses = async () => {
    if (!currentWalletId) return;

    try {
      console.log('[Receive] initializing receive addresses', {
        walletId: currentWalletId,
      });
      await KeyService.bootstrapInitialAddressBatch(currentWalletId, 0, 20);
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
        setSelectedPrivKey(null);
        setIsPrivKeyUnlocked(false);
        setPubKeyTapCount(0);
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

    setPubKeyTapCount(0);
    setIsPrivKeyUnlocked(false);
    setSelectedWalletKey(selectedKey);
    setSelectedQuantumrootVault(null);
    setSelectedAddressPair({ address, tokenAddress });
    setSelectedAddress(address);
    setSelectedPubKey(pubkey);
    setSelectedPKH(pkh);
    setSelectedPrivKey(null); // WIF only after explicit privkey unlock
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
    if (searchParams.get('panel') === 'addresses') {
      setShowAddressListPopup(true);
    }
  }, [searchParams]);

  useLayoutEffect(() => {
    const updateQrSize = () => {
      const viewportHeight =
        window.visualViewport?.height ?? window.innerHeight;
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const addressBrowserHeight = addressBrowserRef.current?.offsetHeight ?? 0;
      const addressTypeToggleHeight =
        addressTypeToggleRef.current?.offsetHeight ?? 0;
      const qrMetaHeight = qrMetaRef.current?.offsetHeight ?? 0;

      const containerWidth = Math.min(
        viewportWidth,
        receiveBodyRef.current?.clientWidth ?? viewportWidth
      );

      const availableHeight =
        receiveBodyRef.current?.clientHeight ??
        Math.max(0, viewportHeight * 0.52);
      const fixedVerticalSpace =
        addressBrowserHeight +
        addressTypeToggleHeight +
        qrMetaHeight +
        68 + // card paddings and gaps inside the scroll area
        24;
      const maxByHeight = Math.max(96, availableHeight - fixedVerticalSpace);
      const maxByWidth = Math.max(136, Math.floor(containerWidth * 0.68) - 24);
      const nextSize = Math.floor(Math.min(176, maxByHeight, maxByWidth));

      setQrCodeSize(Math.max(96, nextSize));
    };

    updateQrSize();
    window.visualViewport?.addEventListener('resize', updateQrSize);
    window.addEventListener('resize', updateQrSize);

    const observer = new ResizeObserver(() => {
      updateQrSize();
    });

    [
      receiveHeaderRef.current,
      addressBrowserRef.current,
      addressTypeToggleRef.current,
      qrMetaRef.current,
      receiveBodyRef.current,
    ].forEach((node) => {
      if (node) observer.observe(node);
    });

    return () => {
      window.visualViewport?.removeEventListener('resize', updateQrSize);
      window.removeEventListener('resize', updateQrSize);
      observer.disconnect();
    };
  }, [selectedAddress]);

  const handlePubKeyTabClick = () => {
    if (!canRevealPrivateKey) {
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

  // Load WIF only when the user has unlocked the private-key view (password
  // re-prompt is intentional for reveal). Never on plain Receive / address pick.
  useEffect(() => {
    if (!isPrivKeyUnlocked || !selectedAddress || !canRevealPrivateKey) return;
    let cancelled = false;
    void (async () => {
      const wif = await fetchAddressWif(selectedAddress, currentNetwork);
      if (!cancelled) setSelectedPrivKey(wif);
    })();
    return () => {
      cancelled = true;
    };
  }, [canRevealPrivateKey, isPrivKeyUnlocked, selectedAddress, currentNetwork]);

  const handleCopy = async (text: string) => {
    try {
      if (!(await copyToClipboard(text)))
        throw new Error('clipboard write failed');
      await Toast.show({ text: t('receive.copied') });
    } catch (error) {
      console.error('Failed to copy:', error);
      await Toast.show({ text: t('receive.copyFailed') });
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
      nextIsTokenAddress ? sourcePair.tokenAddress : sourcePair.address
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

  const activeAddress = selectedAddress ?? primaryKeyPair?.address ?? '';
  const addressPrefixLength =
    PREFIX[currentNetwork]?.length ?? PREFIX.mainnet.length;
  const receiveAddressLabelMaskLength = 6;
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
    return query
      ? `bitcoincash:${activeAddress}?${query}`
      : `bitcoincash:${activeAddress}`;
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
        ? selectedPubKey ||
          (primaryKeyPair ? hexString(primaryKeyPair.publicKey) : '')
        : qrCodeType === 'pkh'
          ? selectedPKH ||
            (primaryKeyPair ? hexString(primaryKeyPair.pubkeyHash) : '')
          : selectedPrivKey || '';
  const activeLabelDisplay =
    qrCodeType === 'address'
      ? shortenTxHash(
          activeLabel,
          addressPrefixLength,
          receiveAddressLabelMaskLength
        )
      : activeLabel;
  const hasBip21Fields =
    !!bip21Amount.trim() || !!bip21Label.trim() || !!bip21Message.trim();
  const formatQuantumrootBalance = (sats: number) =>
    `${(sats / SATSINBITCOIN).toFixed(8).replace(/\.?0+$/, '') || '0'} BCH`;
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
      selectedQuantumrootVault:
        selectedQuantumrootVault?.receive_address ?? null,
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

  useEffect(() => {
    if (!modeTabsScrollRef.current) return;
    if (qrCodeType === 'privkey') {
      privkeyTabRef.current?.scrollIntoView({
        behavior: 'smooth',
        inline: 'center',
        block: 'nearest',
      });
      return;
    }

    modeTabsScrollRef.current.scrollTo({ left: 0, behavior: 'smooth' });
  }, [qrCodeType]);

  useEffect(() => {
    if (!canRevealPrivateKey || isPrivKeyUnlocked) {
      setPrivKeyUnlockToastVisible(false);
      return;
    }

    if (pubKeyTapCount < 5) {
      setPrivKeyUnlockToastVisible(false);
      return;
    }

    const remainingTaps = Math.max(0, PRIVKEY_UNLOCK_TAPS - pubKeyTapCount);
    setPrivKeyUnlockToastMessage(
      t('receive.privKeyUnlock', { count: remainingTaps })
    );
    setPrivKeyUnlockToastVisible(true);

    const timer = window.setTimeout(() => {
      setPrivKeyUnlockToastVisible(false);
    }, 4000);

    return () => window.clearTimeout(timer);
  }, [canRevealPrivateKey, isPrivKeyUnlocked, pubKeyTapCount, t]);

  const renderAddressTypeToggle = () => {
    return (
      <div className="flex items-center justify-center gap-2">
        <span
          className={isTokenAddress ? 'wallet-muted' : 'wallet-text-strong'}
        >
          {t('receive.regular')}
        </span>
        <button
          type="button"
          onClick={toggleAddressType}
          className={`relative flex h-6 w-12 items-center rounded-full border border-[var(--wallet-border)] transition-colors duration-300 ${
            isTokenAddress
              ? 'bg-[var(--wallet-accent)]'
              : 'wallet-surface-strong'
          }`}
          aria-label={t('receive.toggleAddressType')}
        >
          <span
            className={`h-6 w-6 rounded-full shadow-md transition-transform duration-300 ${
              isTokenAddress ? 'translate-x-6' : 'translate-x-0'
            }`}
            style={{ backgroundColor: 'var(--wallet-card-bg)' }}
          />
        </button>
        <span
          className={isTokenAddress ? 'wallet-text-strong' : 'wallet-muted'}
        >
          {t('receive.cashToken')}
        </span>
      </div>
    );
  };

  const renderReceiveContent = () => {
    if (!hasReceiveKeys) {
      return (
        <SectionCard className="p-4">
          <SectionHeader
            title={t('receive.addressesNotReady')}
            subtitle={t('receive.prepareAddressesDescription')}
            compact
          />
          <div className="space-y-3">
            <EmptyState message={t('receive.noAddressesLoaded')} />
            <button
              type="button"
              className="wallet-btn-secondary w-full"
              onClick={() => void handleInitializeReceiveAddresses()}
            >
              {t('receive.prepareAddresses')}
            </button>
          </div>
        </SectionCard>
      );
    }

    const qrSection = (
      <SectionCard className="p-3">
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            className="rounded-2xl border border-[rgba(0,0,0,0.08)] bg-white p-1 shadow-sm transition-transform duration-200 hover:scale-[1.01] focus:outline-none focus:ring-2 focus:ring-[var(--wallet-accent)] focus:ring-offset-2"
            onClick={() => setShowQrPopup(true)}
            aria-label={t('receive.openQrPreview')}
          >
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
          </button>
          <div ref={qrMetaRef} className="w-full space-y-3">
            <div className="w-full flex items-center gap-1.5">
              <button
                type="button"
                data-testid="receive-address"
                className={`min-w-0 overflow-hidden wallet-surface-strong rounded-[12px] px-3 py-2 text-left hover:brightness-[0.97] ${
                  qrCodeType === 'address' ? 'flex-1' : 'w-full'
                }`}
                onClick={() => handleCopy(activeQrPayload)}
              >
                {qrCodeType === 'address' ? (
                  <span className="block min-w-0 overflow-hidden whitespace-nowrap text-sm">
                    {activeLabelDisplay}
                  </span>
                ) : (
                  renderMaskedLabel(activeLabelDisplay, 7, 7)
                )}
              </button>
              {qrCodeType === 'address' && (
                <button
                  type="button"
                  className={`wallet-btn-secondary shrink-0 whitespace-nowrap rounded-[12px] px-2.5 py-1.5 text-[11px] ${
                    showBip21Popup ? 'wallet-segment-active' : ''
                  }`}
                  onClick={() => setShowBip21Popup(true)}
                >
                  BIP21
                </button>
              )}
            </div>
          </div>
        </div>
      </SectionCard>
    );

    const addressBrowser = (
      <div ref={addressBrowserRef}>
        <SectionCard className="p-3">
          <div className="flex items-center justify-between gap-3">
            <SectionHeader
              title={t('receive.switchAddress')}
              subtitle={
                addressType === 'main'
                  ? t('receive.mainAddressCount', {
                      count: keyPairsToDisplay.length,
                    })
                  : t('receive.changeAddressCount', {
                      count: keyPairsToDisplay.length,
                    })
              }
              compact
            />
            <button
              type="button"
              className="wallet-btn-secondary px-3 py-1.5 text-xs"
              onClick={() => setShowAddressListPopup(true)}
            >
              {t('receive.switch')}
            </button>
          </div>
        </SectionCard>
      </div>
    );

    const modeButtons = (
      <SectionCard className="p-2.5">
        <div
          ref={modeTabsScrollRef}
          className="flex gap-1.5 overflow-x-auto overscroll-x-contain pb-1"
        >
          <button
            type="button"
            className={`min-h-[38px] min-w-[82px] shrink-0 rounded-[14px] px-2 py-1.5 text-[12px] font-bold leading-none whitespace-nowrap ${
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
            className={`min-h-[38px] min-w-[82px] shrink-0 rounded-[14px] px-2 py-1.5 text-[12px] font-bold leading-none whitespace-nowrap ${
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
            className={`min-h-[38px] min-w-[82px] shrink-0 rounded-[14px] px-2 py-1.5 text-[12px] font-bold leading-none whitespace-nowrap ${
              qrCodeType === 'pkh'
                ? 'wallet-segment-active'
                : 'wallet-segment-inactive'
            }`}
            onClick={() => setQrCodeType('pkh')}
          >
            PKH
          </button>
          {canRevealPrivateKey && (
            <button
              ref={privkeyTabRef}
              type="button"
              className={`min-h-[38px] min-w-[82px] shrink-0 rounded-[14px] px-2 py-1.5 text-[12px] font-bold leading-none whitespace-nowrap ${
                qrCodeType === 'privkey'
                  ? 'wallet-segment-active'
                  : 'wallet-segment-inactive'
              }`}
              onClick={() => {
                // First open of PrivKey still requires the tap unlock (or we
                // re-prompt via reveal when WIF is loaded after unlock).
                if (!isPrivKeyUnlocked) {
                  handlePubKeyTabClick();
                  return;
                }
                setQrCodeType('privkey');
              }}
            >
              PrivKey
            </button>
          )}
        </div>
      </SectionCard>
    );

    return (
      <div
        className="wallet-card wallet-signature-panel flex min-h-0 flex-1 flex-col overflow-hidden p-3"
        data-receive-screen
      >
        <div
          ref={receiveBodyRef}
          className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain pr-1 pb-0"
        >
          {addressBrowser}
          <div
            ref={addressTypeToggleRef}
            className="flex min-h-[34px] items-center justify-center"
          >
            {qrCodeType === 'address' ? renderAddressTypeToggle() : null}
          </div>
          {qrSection}
          {!selectedAddress && (
            <SectionCard className="p-4">
              <SectionHeader
                title={t('receive.addressesNotReady')}
                subtitle={t('receive.prepareAddressesDescription')}
                compact
              />
              <div className="mt-3 space-y-3">
                <EmptyState message={t('receive.noAddressesLoaded')} />
                <button
                  type="button"
                  className="wallet-btn-secondary w-full"
                  onClick={() => void handleInitializeReceiveAddresses()}
                >
                  {t('receive.prepareAddresses')}
                </button>
              </div>
            </SectionCard>
          )}
          {/* RPA Cash Code at the bottom of the receive list (UI preference). */}
          <RpaReceiveCard walletId={currentWalletId} />
        </div>

        <div className="relative shrink-0 pt-3">
          {privKeyUnlockToastVisible && (
            <div className="pointer-events-none absolute inset-x-0 bottom-full z-40 mb-3 flex justify-center px-1">
              <div
                className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-[18px] border border-[var(--wallet-warning-border)] bg-[var(--wallet-warning-bg)] px-4 py-3 shadow-2xl backdrop-blur-sm"
                role="status"
                aria-live="polite"
              >
                <div className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--wallet-warning-text)]" />
                <div className="min-w-0 flex-1">
                  <div
                    className="text-sm font-semibold"
                    style={{ color: 'var(--wallet-warning-text)' }}
                  >
                    {privKeyUnlockToastMessage}
                  </div>
                  <div className="mt-0.5 text-xs wallet-muted">
                    {isPrivKeyUnlocked
                      ? t('receive.privKeyReady')
                      : t('receive.tapPubKey')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setPrivKeyUnlockToastVisible(false)}
                  className="ml-1 rounded-full p-1 wallet-muted hover:brightness-95"
                  aria-label={t('receive.dismissUnlockAlert')}
                  title={t('receive.dismiss')}
                >
                  ✕
                </button>
              </div>
            </div>
          )}
          <div className="space-y-3">
            {modeButtons}
            <button
              type="button"
              onClick={() => navigate(backTarget)}
              className="wallet-btn-danger w-full py-3 font-semibold shadow-xl"
            >
              {t('receive.back')}
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <div ref={receiveHeaderRef}>
          <PageHeader title={t('receive.title')} compact />
        </div>

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
              <h3 className="text-lg font-bold">
                {t('receive.quantumrootStatus')}
              </h3>
              {loadingQuantumrootStatus && (
                <span className="text-xs wallet-muted">
                  {t('receive.syncing')}
                </span>
              )}
            </div>
            <p className="mb-3 text-xs wallet-muted">
              {t('receive.readOnlyStatus')}
            </p>
            {quantumrootStatus ? (
              <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <div className="wallet-surface-strong rounded-[14px] p-3">
                    <div className="mb-1 text-[11px] font-semibold wallet-muted">
                      {t('receive.receiveBalance')}
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
                      {t('receive.quantumLock')}
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
                    {t('receive.receiveAddress')}
                  </div>
                  <div className="break-all font-mono text-xs">
                    {selectedQuantumrootVault?.receive_address ??
                      t('receive.unavailable')}
                  </div>
                </div>
                <div className="wallet-surface-strong rounded-[14px] p-3">
                  <div className="mb-1 text-[11px] font-semibold wallet-muted">
                    {t('receive.quantumLockAddress')}
                  </div>
                  <div className="break-all font-mono text-xs">
                    {selectedQuantumrootVault?.quantum_lock_address ??
                      t('receive.unavailable')}
                  </div>
                </div>
              </div>
            ) : (
              !loadingQuantumrootStatus && (
                <p className="text-sm wallet-muted">
                  {t('receive.noVaultFunds')}
                </p>
              )
            )}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="wallet-btn-secondary flex-1"
                onClick={() => setShowQuantumrootStatusPopup(false)}
              >
                {t('receive.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showQrPopup && (
        <Popup
          closePopups={() => setShowQrPopup(false)}
          closeButtonText={t('receive.close')}
        >
          <div className="space-y-4 p-1 sm:p-2">
            <div className="space-y-1 text-center">
              <h3 className="text-lg font-bold">{t('receive.receiveQr')}</h3>
              <p className="text-xs wallet-muted">
                {t('receive.qrCopyDescription')}
              </p>
            </div>
            <div className="flex justify-center">
              <button
                type="button"
                className="rounded-[24px] border border-[rgba(0,0,0,0.08)] bg-white p-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--wallet-accent)] focus:ring-offset-2"
                onClick={() => handleCopy(activeQrPayload)}
                aria-label={t('receive.copyQrPayload')}
              >
                <QRCodeSVG
                  value={activeQrPayload}
                  size={Math.max(
                    220,
                    Math.min(320, Math.floor(qrCodeSize * 1.6))
                  )}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="H"
                  marginSize={1}
                  imageSettings={{
                    src: '/assets/images/OPTNUIkeyline.png',
                    height: 52,
                    width: 52,
                    excavate: true,
                  }}
                />
              </button>
            </div>
            <div className="rounded-[18px] bg-[var(--wallet-surface-strong)] px-4 py-3 text-center">
              {qrCodeType === 'address' ? (
                <span className="block min-w-0 overflow-hidden whitespace-nowrap text-sm">
                  {activeLabelDisplay}
                </span>
              ) : (
                renderMaskedLabel(activeLabelDisplay, 7, 7)
              )}
            </div>
          </div>
        </Popup>
      )}

      {showBip21Popup && (
        <Popup
          closePopups={() => setShowBip21Popup(false)}
          closeButtonText={t('receive.close')}
        >
          <SectionHeader
            title={t('receive.bip21Title')}
            subtitle={t('receive.bip21Description')}
            compact
          />
          <div className="mt-3 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold wallet-muted">
                {t('receive.amountBch')}
              </label>
              <input
                value={bip21Amount}
                onChange={(e) => handleBip21AmountChange(e.target.value)}
                inputMode="decimal"
                placeholder={t('receive.optionalExample')}
                className="w-full rounded-[14px] border border-[var(--wallet-border)] bg-transparent px-3 py-2 outline-none wallet-surface-strong"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold wallet-muted">
                {t('receive.label')}
              </label>
              <input
                value={bip21Label}
                onChange={(e) => setBip21Label(e.target.value)}
                placeholder={t('receive.optional')}
                className="w-full rounded-[14px] border border-[var(--wallet-border)] bg-transparent px-3 py-2 outline-none wallet-surface-strong"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold wallet-muted">
                {t('receive.message')}
              </label>
              <input
                value={bip21Message}
                onChange={(e) => setBip21Message(e.target.value)}
                placeholder={t('receive.optional')}
                className="w-full rounded-[14px] border border-[var(--wallet-border)] bg-transparent px-3 py-2 outline-none wallet-surface-strong"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="wallet-btn-secondary px-3 py-1.5 text-xs"
                onClick={() => void handleCopy(bip21Uri || activeAddress)}
              >
                {t('receive.copyBip21')}
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
                {t('receive.clear')}
              </button>
            </div>
            <p className="text-[11px] wallet-muted">{t('receive.bip21Help')}</p>
            {hasBip21Fields && (
              <p className="text-[11px] wallet-muted">
                {t('receive.bip21Active')}
              </p>
            )}
          </div>
        </Popup>
      )}

      {showAddressListPopup && (
        <Popup
          closePopups={() => setShowAddressListPopup(false)}
          closeButtonText={t('receive.close')}
        >
          <SectionHeader
            title={t('receive.seeAllAddresses')}
            subtitle={
              addressType === 'main'
                ? t('receive.mainAddressCount', {
                    count: keyPairsToDisplay.length,
                  })
                : t('receive.changeAddressCount', {
                    count: keyPairsToDisplay.length,
                  })
            }
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
              {t('receive.main')}
            </button>
            <button
              type="button"
              className={`wallet-btn-secondary px-3 py-1.5 text-xs ${
                addressType === 'change' ? 'wallet-segment-active' : ''
              }`}
              onClick={() => setAddressType('change')}
            >
              {t('receive.change')}
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
                  keyPair.addressIndex,
                  derivationPath || undefined
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
                        void handleAddressSelect(
                          keyPair.tokenAddress,
                          displayAddress
                        );
                        setShowAddressListPopup(false);
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold wallet-text-strong">
                            {shortenTxHash(
                              displayAddress,
                              addressPrefixLength,
                              receiveAddressLabelMaskLength
                            )}
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
              <EmptyState message={t('receive.noBranchAddresses')} />
            )}
          </div>
        </Popup>
      )}
    </WalletScreen>
  );
};

export default Receive;
