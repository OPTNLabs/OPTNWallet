import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import Bip44AccountPathFields from '../../components/Bip44AccountPathFields';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import {
  selectWalletDerivationPath,
  selectWalletDerivationPathSource,
  selectWalletId,
} from '../../state/slices/walletSlice';
import {
  getBchAccountPath,
  normalizeBchAccountPath,
} from '../../services/HdWalletService';
import {
  getDefaultPathForNetwork,
  reconfigureActiveWallet,
} from '../../services/WalletReconfigurationService';
import { useWalletConfirm } from '../../components/WalletConfirmDialog';
import { useI18n } from '../../i18n/useI18n';

export const DerivationPathSettings: React.FC = () => {
  const walletId = useSelector(selectWalletId);
  const network = useSelector(selectCurrentNetwork);
  const storedPath = useSelector(selectWalletDerivationPath);
  const source = useSelector(selectWalletDerivationPathSource);
  const { t } = useI18n();
  const [pathInput, setPathInput] = useState(
    () => storedPath || getBchAccountPath(network)
  );
  const [saving, setSaving] = useState(false);
  const [pathValid, setPathValid] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const confirm = useWalletConfirm();

  useEffect(() => {
    setPathInput(storedPath || getBchAccountPath(network));
  }, [network, storedPath]);

  const applyPath = async (path: string, nextSource: 'default' | 'custom') => {
    if (saving || walletId <= 0) return;
    let normalizedPath: string;
    try {
      normalizedPath = normalizeBchAccountPath(path);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : t('settingsDerivation.invalidPath')
      );
      return;
    }

    if (normalizedPath === storedPath && nextSource === source) {
      setMessage(t('settingsDerivation.alreadyActive'));
      return;
    }

    const confirmed = await confirm(t('settingsDerivation.confirm'));
    if (!confirmed) return;

    setSaving(true);
    setMessage(null);
    try {
      await reconfigureActiveWallet({
        walletId,
        network,
        derivationPath: normalizedPath,
        derivationPathSource: nextSource,
        operation: 'derivation-change',
      });
      setPathInput(normalizedPath);
      setMessage(t('settingsDerivation.completed'));
    } catch (error) {
      console.error('[DerivationPathSettings] reconfiguration failed:', error);
      setMessage(
        error instanceof Error ? error.message : t('settingsDerivation.failed')
      );
    } finally {
      setSaving(false);
    }
  };

  const resetToNetworkDefault = () => {
    const defaultPath = getDefaultPathForNetwork(network);
    setPathInput(defaultPath);
    void applyPath(defaultPath, 'default');
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs wallet-muted leading-relaxed">
        {t('settingsDerivation.description')}
      </p>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold wallet-text-strong">
          {t('settingsDerivation.activePath')}
        </span>
        <Bip44AccountPathFields
          network={network}
          value={pathInput}
          onChange={setPathInput}
          onValidityChange={setPathValid}
          disabled={saving}
        />
      </div>
      <p className="text-xs wallet-muted">
        {t('settingsDerivation.currentMode', {
          mode:
            source === 'custom'
              ? t('settingsDerivation.custom')
              : t('settingsDerivation.networkDefault'),
        })}
      </p>
      {message && <p className="text-xs wallet-muted">{message}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => void applyPath(pathInput, 'custom')}
          disabled={saving || walletId <= 0 || !pathValid}
          className="wallet-btn-primary flex-1"
        >
          {saving
            ? t('settingsDerivation.reconfiguring')
            : t('settingsDerivation.changeResync')}
        </button>
        <button
          type="button"
          onClick={resetToNetworkDefault}
          disabled={saving}
          className="wallet-btn-secondary flex-1"
        >
          {t('settingsDerivation.useDefault')}
        </button>
      </div>
    </div>
  );
};

export default DerivationPathSettings;
