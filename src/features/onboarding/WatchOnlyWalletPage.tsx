import { useMemo, useState } from 'react';
import { CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';

import WalletManager from '../../apis/WalletManager/WalletManager';
import OnboardingCard from './components/OnboardingCard';
import OnboardingScreen from './components/OnboardingScreen';
import { useI18n } from '../../i18n/useI18n';
import { homeRoute } from '../../navigation/routes';
import { scanBarcodeSafely } from '../../utils/barcodeScanner';
import {
  Network,
  setNetwork,
} from '../../state/slices/networkSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import {
  setWalletDerivationPath,
  setWalletId,
  setWalletNetwork,
  setWalletType,
} from '../../state/slices/walletSlice';
import {
  createWatchOnlyWallet,
  WATCH_ONLY_WALLET_TYPE,
} from '../../services/watchOnlyWallet';
import { deriveWatchOnlyAccountPreview } from '../../services/watchOnlyAccountPreview';

const WatchOnlyWalletPage = () => {
  const currentNetwork = useSelector(selectCurrentNetwork);
  const [network, setSelectedNetwork] = useState(currentNetwork);
  const [walletName, setWalletName] = useState('');
  const [accountXpub, setAccountXpub] = useState('');
  const [masterFingerprint, setMasterFingerprint] = useState('');
  const [scanBusy, setScanBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const navigate = useNavigate();
  const dispatch = useDispatch();
  const { t } = useI18n();

  const preview = useMemo(() => {
    if (!accountXpub.trim()) return null;
    try {
      return deriveWatchOnlyAccountPreview(network, accountXpub);
    } catch {
      return null;
    }
  }, [accountXpub, network]);

  const handleScan = async () => {
    setScanBusy(true);
    setError('');
    try {
      const result = await scanBarcodeSafely({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      });
      const scanned = result?.ScanResult?.trim();
      if (scanned) setAccountXpub(scanned);
    } catch (scanError) {
      setError(
        scanError instanceof Error
          ? scanError.message
          : 'Could not scan the account xPub.'
      );
    } finally {
      setScanBusy(false);
    }
  };

  const handleCreate = async () => {
    if (busy) return;
    if (!walletName.trim()) {
      setError('Give the wallet a name.');
      return;
    }
    if (!accountXpub.trim()) {
      setError('Paste or scan the account xPub exported by SeedCash.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const walletId = await createWatchOnlyWallet({
        name: walletName,
        accountXpub,
        network,
        masterFingerprint: masterFingerprint.trim() || undefined,
      });

      const metadata = await WalletManager().getWalletMetadata(walletId);
      const resolvedNetwork = metadata?.networkType ?? network;
      const resolvedPath =
        metadata?.derivation_path ??
        deriveWatchOnlyAccountPreview(network, accountXpub).accountPath;

      dispatch(setWalletId(walletId));
      dispatch(setWalletNetwork(resolvedNetwork));
      dispatch(setWalletType(WATCH_ONLY_WALLET_TYPE));
      dispatch(
        setWalletDerivationPath({
          path: resolvedPath,
          source:
            metadata?.derivation_path_source === 'custom'
              ? 'custom'
              : 'default',
        })
      );
      dispatch(setNetwork(resolvedNetwork));
      navigate(homeRoute(walletId));
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : 'Could not create the watch-only wallet.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <OnboardingScreen>
      <OnboardingCard
        title={t('onboarding.createWatchOnly')}
        maxWidthClassName="max-w-lg"
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed wallet-muted">
            {t('watchOnly.description')}
          </p>

          <label className="block space-y-1 text-sm wallet-text-strong">
            {t('onboarding.walletNamePlaceholder')}
            <input
              value={walletName}
              onChange={(event) => {
                setWalletName(event.target.value);
                setError('');
              }}
              className="wallet-input w-full rounded-md px-3 py-2"
              placeholder={t('onboarding.walletNamePlaceholder')}
              autoComplete="off"
            />
          </label>

          <label className="block space-y-1 text-sm wallet-text-strong">
            {t('watchOnly.network')}
            <select
              value={network}
              onChange={(event) => {
                setSelectedNetwork(event.target.value as Network);
                setError('');
              }}
              className="wallet-input w-full rounded-md px-3 py-2"
            >
              <option value={Network.MAINNET}>{t('watchOnly.mainnet')}</option>
              <option value={Network.CHIPNET}>{t('watchOnly.chipnet')}</option>
            </select>
          </label>

          <label className="block space-y-1 text-sm wallet-text-strong">
            {t('watchOnly.accountXpub')}
            <textarea
              value={accountXpub}
              onChange={(event) => {
                setAccountXpub(event.target.value);
                setError('');
              }}
              rows={3}
              spellCheck={false}
              autoComplete="off"
              className="wallet-input w-full resize-none rounded-md px-3 py-2 font-mono text-xs"
              placeholder={t('watchOnly.xpubPlaceholder')}
            />
          </label>

          <button
            type="button"
            onClick={() => void handleScan()}
            disabled={scanBusy || busy}
            className="wallet-btn-secondary w-full py-2 text-sm font-semibold disabled:opacity-50"
          >
            {scanBusy ? 'Scanning…' : t('watchOnly.scanCamera')}
          </button>

          <label className="block space-y-1 text-sm wallet-text-strong">
            Master fingerprint <span className="wallet-muted">(optional)</span>
            <input
              value={masterFingerprint}
              onChange={(event) => {
                setMasterFingerprint(event.target.value);
                setError('');
              }}
              maxLength={8}
              inputMode="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="wallet-input w-full rounded-md px-3 py-2 font-mono uppercase"
              placeholder="8 hex characters"
            />
          </label>

          {preview && (
            <div className="wallet-card space-y-2 p-3 text-xs">
              <p className="font-semibold wallet-text-strong">
                {t('watchOnly.previewTitle')}
              </p>
              <p className="break-all wallet-muted">
                {preview.receive.path}: {preview.receive.address}
              </p>
              <p className="break-all wallet-muted">
                {preview.change.path}: {preview.change.address}
              </p>
            </div>
          )}

          <p className="text-xs leading-relaxed wallet-muted">
            Only public keys are stored on this device. SeedCash keeps the
            mnemonic/private keys and signs transactions offline.
          </p>

          {error && (
            <p role="alert" className="text-sm wallet-danger-text">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={busy}
            className="wallet-btn-primary w-full py-3 text-lg font-bold disabled:opacity-50"
          >
            {busy ? 'Creating…' : t('onboarding.createWatchOnly')}
          </button>

          <button
            type="button"
            onClick={() => navigate('/landing')}
            disabled={busy}
            className="wallet-btn-secondary w-full py-2 text-sm"
          >
            {t('onboarding.back')}
          </button>
        </div>
      </OnboardingCard>
    </OnboardingScreen>
  );
};

export default WatchOnlyWalletPage;
