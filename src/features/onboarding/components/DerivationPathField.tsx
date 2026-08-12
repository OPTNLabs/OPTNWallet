import React from 'react';
import { Network } from '../../../state/slices/networkSlice';
import { getBchAccountPath } from '../../../services/HdWalletService';
import Bip44AccountPathFields from '../../../components/Bip44AccountPathFields';
import NetworkSelector from './NetworkSelector';

type DerivationPathFieldProps = {
  network: Network;
  value: string;
  custom: boolean;
  onChange: (path: string, custom: boolean) => void;
};

export const DerivationPathField: React.FC<DerivationPathFieldProps> = ({
  network,
  value,
  custom,
  onChange,
}) => {
  const defaultPath = getBchAccountPath(network);

  const handleCustomToggle = (enabled: boolean) => {
    if (!enabled) {
      onChange(defaultPath, false);
      return;
    }
    onChange(value === defaultPath ? defaultPath : value, true);
  };

  return (
    <div className="w-full space-y-2 rounded-xl border border-[var(--wallet-border)] wallet-surface-strong p-3">
      <div className="border-b border-[var(--wallet-border)] pb-3">
        <p className="text-sm font-semibold wallet-text-strong">Wallet network</p>
        <p className="text-xs wallet-muted mb-2">
          Choose whether this wallet connects to live funds on Mainnet or test funds on Chipnet.
        </p>
        <NetworkSelector networkType={network} centered />
      </div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold wallet-text-strong">Address derivation</p>
          <p className="text-xs wallet-muted">
            BIP44 account path used to derive this wallet.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs wallet-muted">
          <input
            type="checkbox"
            checked={custom}
            onChange={(event) => handleCustomToggle(event.target.checked)}
          />
          Customize
        </label>
      </div>
      {custom ? (
        <Bip44AccountPathFields
          network={network}
          value={value}
          onChange={(path) => onChange(path, true)}
        />
      ) : (
        <code className="block text-center text-sm wallet-text-strong font-mono">
          {defaultPath}
        </code>
      )}
    </div>
  );
};

export default DerivationPathField;
