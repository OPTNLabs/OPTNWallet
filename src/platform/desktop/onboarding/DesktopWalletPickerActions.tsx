import type { FC } from 'react';
import { Link } from 'react-router-dom';

type DesktopWalletPickerActionsProps = {
  hasWallets: boolean;
  onHardware: () => void;
  onWatchOnly: () => void;
  onKeystone: () => void;
};

export const DesktopWalletPickerActions: FC<
  DesktopWalletPickerActionsProps
> = ({ hasWallets, onHardware, onWatchOnly, onKeystone }) => (
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
    {/* The same watch-only wallet, reached by the shorter route: a Keystone
        account QR carries the fingerprint and derivation path, so there is
        nothing to type. Named after the device because that is what someone
        holding one will look for. */}
    <button
      type="button"
      onClick={onKeystone}
      className="wallet-btn-secondary w-full text-center py-3 font-bold"
    >
      Set up Keystone
    </button>
  </div>
);
