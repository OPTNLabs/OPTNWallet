import React from 'react';
import { Network } from '../../../state/slices/networkSlice';
import { getBchAccountPath } from '../../../services/HdWalletService';
import Bip44AccountPathFields from '../../../components/Bip44AccountPathFields';

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
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold wallet-text-strong">
            Derivation path
          </p>
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
