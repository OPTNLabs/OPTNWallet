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

export const DerivationPathSettings: React.FC = () => {
  const walletId = useSelector(selectWalletId);
  const network = useSelector(selectCurrentNetwork);
  const storedPath = useSelector(selectWalletDerivationPath);
  const source = useSelector(selectWalletDerivationPathSource);
  const [pathInput, setPathInput] = useState(
    () => storedPath || getBchAccountPath(network)
  );
  const [saving, setSaving] = useState(false);
  const [pathValid, setPathValid] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

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
        error instanceof Error ? error.message : 'Invalid derivation path.'
      );
      return;
    }

    if (normalizedPath === storedPath && nextSource === source) {
      setMessage('This derivation path is already active.');
      return;
    }

    const confirmed = window.confirm(
      'Changing the derivation path clears the current address, history, and UTXO records. The wallet will then regenerate and resync only the new path. Continue?'
    );
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
      setMessage('Derivation path changed and wallet resync completed.');
    } catch (error) {
      console.error('[DerivationPathSettings] reconfiguration failed:', error);
      setMessage(
        error instanceof Error
          ? error.message
          : 'Wallet reconfiguration failed.'
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
        OPTN supports one active BIP44 account path at a time. Reconfiguring it
        removes the old derived records and performs a fresh receive/change
        discovery and resync.
      </p>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold wallet-text-strong">
          Active BIP44 account path
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
        Current mode: {source === 'custom' ? 'custom' : 'network default'}.
      </p>
      {message && <p className="text-xs wallet-muted">{message}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => void applyPath(pathInput, 'custom')}
          disabled={saving || walletId <= 0 || !pathValid}
          className="wallet-btn-primary flex-1"
        >
          {saving ? 'Reconfiguring…' : 'Change and resync'}
        </button>
        <button
          type="button"
          onClick={resetToNetworkDefault}
          disabled={saving}
          className="wallet-btn-secondary flex-1"
        >
          Use network default
        </button>
      </div>
    </div>
  );
};

export default DerivationPathSettings;
