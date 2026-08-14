import type { FC } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../../i18n/useI18n';

type DesktopWalletPickerActionsProps = {
  hasWallets: boolean;
  onHardware: () => void;
  /** Opens create watch-only (xPub + password; Airgap/Keystone section inside). */
  onWatchOnly: () => void;
};

export const DesktopWalletPickerActions: FC<
  DesktopWalletPickerActionsProps
> = ({ hasWallets, onHardware, onWatchOnly }) => {
  const { t } = useI18n();
  return (
    <div className="space-y-2">
      <p className="text-sm wallet-muted">
        {hasWallets
          ? t('desktopWallet.addAnother')
          : t('onboarding.createWallet')}
      </p>
      <Link
        to="/createwallet"
        className="wallet-btn-primary w-full block text-center py-3 font-bold"
      >
        {t('onboarding.createNewWallet')}
      </Link>
      <Link
        to="/importwallet"
        className="wallet-btn-secondary w-full block text-center py-3 font-bold"
      >
        {t('onboarding.importWallet')}
      </Link>
      <button
        type="button"
        onClick={onHardware}
        className="wallet-btn-secondary w-full text-center py-3 font-bold"
      >
        {t('onboarding.connectHardware')}
      </button>
      <button
        type="button"
        onClick={onWatchOnly}
        className="wallet-btn-secondary w-full text-center py-3 font-bold"
      >
        {t('onboarding.createWatchOnly')}
      </button>
    </div>
  );
};
