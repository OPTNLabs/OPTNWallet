import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import Bip44AccountPathFields from '../../components/Bip44AccountPathFields';
import DerivationDiscoveryResult from '../../components/DerivationDiscoveryResult';
import KeyManager from '../../apis/WalletManager/KeyManager';
import { useDerivationDiscovery } from '../../hooks/useDerivationDiscovery';
import type { AccountXpubResolver } from '../../services/DerivationPathProbe';
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
  const confirm = useWalletConfirm();
  const activePath = storedPath || getBchAccountPath(network);
  const networkDefaultPath = getDefaultPathForNetwork(network);

  const keyManager = useMemo(() => KeyManager(), []);
  const {
    state: discoveryState,
    scan,
    cancel: cancelScan,
    reset: resetScan,
  } = useDerivationDiscovery();

  // The seed is read and dropped inside KeyManager; a scan runs on public keys
  // only, so no mnemonic reaches this component.
  const resolveXpubs = useCallback<AccountXpubResolver>(
    async (accountPath) => {
      const xpubs = await keyManager.getXpubsForAccountPath(
        walletId,
        accountPath
      );
      return { receive: xpubs.receive, change: xpubs.change };
    },
    [keyManager, walletId]
  );

  const startScan = useCallback(() => {
    setMessage(null);
    void scan(network, resolveXpubs);
  }, [network, resolveXpubs, scan]);

  useEffect(() => {
    setPathInput(storedPath || getBchAccountPath(network));
  }, [network, storedPath]);

  useEffect(() => {
    // A result belongs to exactly one unlocked wallet and one network. Never
    // leave an old wallet's path suggestion visible after either changes.
    resetScan();
    setMessage(null);
  }, [network, resetScan, walletId]);

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

    const confirmed = await confirm(
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
      // The scan answered a question about the old path; keep it on screen and
      // it now describes a wallet that no longer exists.
      resetScan();
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
    setPathInput(networkDefaultPath);
    void applyPath(networkDefaultPath, 'default');
  };

  const adoptDiscoveredPath = (path: string) => {
    setPathInput(path);

    // In an ambiguous result the user can select the already-active path. That
    // is a choice to keep it, not permission to purge and rebuild the wallet.
    if (path === activePath) {
      resetScan();
      setMessage('This derivation path is already active.');
      return;
    }

    void applyPath(path, path === networkDefaultPath ? 'default' : 'custom');
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
      <div className="flex flex-col gap-2 border-t wallet-border pt-4">
        <span className="text-sm font-semibold wallet-text-strong">
          Not seeing your coins?
        </span>
        <p className="text-xs wallet-muted leading-relaxed">
          A wallet restored from another app may hold its coins on a different
          account path. This checks the standard paths for transaction history.
          It only reads — nothing is moved or changed until you choose.
        </p>
        <button
          type="button"
          onClick={startScan}
          disabled={
            saving || walletId <= 0 || discoveryState.status === 'scanning'
          }
          className="wallet-btn-secondary self-start"
        >
          Find where my coins are
        </button>
        <DerivationDiscoveryResult
          state={discoveryState}
          currentPath={activePath}
          defaultPath={networkDefaultPath}
          onAdopt={adoptDiscoveredPath}
          onCancel={cancelScan}
          onRetry={startScan}
          context="settings"
        />
      </div>
    </div>
  );
};

export default DerivationPathSettings;
