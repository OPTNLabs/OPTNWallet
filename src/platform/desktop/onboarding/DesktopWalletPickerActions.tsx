import type { FC } from 'react';
import { Link } from 'react-router-dom';

type DesktopWalletPickerActionsProps = {
  hasWallets: boolean;
  onHardware: () => void;
  /** Opens create watch-only (xPub + password; Airgap/Keystone section inside). */
  onWatchOnly: () => void;
};

export const DesktopWalletPickerActions: FC<
  DesktopWalletPickerActionsProps
> = ({ hasWallets, onHardware, onWatchOnly }) => (
  <div className="space-y-2">
    <p className="text-sm wallet-muted">
      {hasWallets ? 'Add another wallet' : 'Get started'}
    </p>
    <Link
      to="/createwallet"
      className="wallet-btn-primary w-full block text-center py-3 font-bold"
    >
      Create New Wallet
    </Link>
    <Link
      to="/importwallet"
      className="wallet-btn-secondary w-full block text-center py-3 font-bold"
    >
      Import Wallet
    </Link>
    <button
      type="button"
      onClick={onHardware}
      className="wallet-btn-secondary w-full text-center py-3 font-bold"
    >
      Use a hardware device
    </button>
    <button
      type="button"
      onClick={onWatchOnly}
      className="wallet-btn-secondary w-full text-center py-3 font-bold"
    >
      Create Watch-Only Wallet
    </button>
  </div>
);
