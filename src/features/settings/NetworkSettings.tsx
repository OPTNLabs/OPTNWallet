import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { Network, setNetwork } from '../../state/slices/networkSlice';
import { resetWallet, setWalletId, setWalletNetwork, setWalletType, selectWalletId } from '../../state/slices/walletSlice';
import { resetUTXOs } from '../../state/slices/utxoSlice';
import { resetTransactions } from '../../state/slices/transactionSlice';
import { resetContract } from '../../state/slices/contractSlice';
import { clearTransaction } from '../../state/slices/transactionBuilderSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { AppDispatch } from '../../state/store';
import { WalletType } from '../../types/wallet';
import DatabaseService from '../../apis/DatabaseManager/DatabaseService';
import ElectrumServer from '../../apis/ElectrumServer/ElectrumServer';
import { invalidateUTXOCache } from '../../services/ElectrumService';
import FaucetView from '../../components/FaucetView';

// Tauri injects this global into the desktop WebView; absent in the mobile
// Capacitor WebView and a plain browser. Same check InfraUrls.ts uses.
const isDesktop = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// To add a new network in future:
//  1. Add its value to the Network enum in networkSlice.ts
//  2. Add its Electrum + infra servers in src/utils/servers/InfraUrls.ts
//  3. Update the network-parsing switch in WalletManager.ts (several spots)
//  4. Add an entry to SUPPORTED_NETWORKS below — UI handles the rest
const SUPPORTED_NETWORKS: {
  id: Network;
  label: string;
  description: string;
  color: string;
  showFaucet?: boolean;
}[] = [
  {
    id: Network.MAINNET,
    label: 'Mainnet',
    description: 'Live BCH network — real funds',
    color: '#22c55e',
  },
  {
    id: Network.CHIPNET,
    label: 'Chipnet',
    description: 'BCH testnet for upcoming CHIPs — test funds only',
    color: '#6366f1',
    showFaucet: true,
  },
];

async function findWalletForNetwork(target: Network): Promise<{ id: number; walletType: WalletType } | null> {
  const dbService = DatabaseService();
  await dbService.ensureDatabaseStarted();
  const db = dbService.getDatabase();
  if (!db) return null;

  try {
    const query = db.prepare('SELECT id, walletType FROM wallets WHERE networkType = ? LIMIT 1');
    query.bind([target]);
    if (!query.step()) { query.free(); return null; }
    const row = query.getAsObject() as { id: unknown; walletType: unknown };
    query.free();
    return {
      id: Number(row.id),
      walletType: row.walletType === WalletType.QUANTUMROOT ? WalletType.QUANTUMROOT : WalletType.STANDARD,
    };
  } catch {
    return null;
  }
}

export const NetworkSettings: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const currentNetwork = useSelector(selectCurrentNetwork);
  const walletId = useSelector(selectWalletId);
  const [switching, setSwitching] = useState(false);

  const handleSwitch = async (target: Network) => {
    if (target === currentNetwork || switching) return;
    setSwitching(true);

    // Drop the live Electrum connection and its caches before switching:
    // ElectrumServer keeps a singleton bound to the OLD network's servers, so
    // without this the wallet keeps showing the old network's balances/history
    // even after currentNetwork flips. The next query reconnects against the
    // now-current network's pool.
    invalidateUTXOCache();
    try {
      await ElectrumServer().electrumDisconnect();
    } catch {
      /* ignore */
    }

    try {
      // Desktop: keep the user logged in. A wallet is bound to one network, so
      // switching moves to the SAME seed's twin wallet on the target network,
      // reusing the in-RAM key (no password prompt, no lock-out). Loaded via
      // dynamic import so this Tauri-only module never enters the mobile bundle.
      if (isDesktop() && walletId > 0) {
        const { switchNetworkSameSeed } = await import(
          '../../platform/desktop/DesktopWalletManager'
        );
        const twin = await switchNetworkSameSeed(walletId, target);
        if (twin) {
          dispatch(setNetwork(target));
          dispatch(setWalletId(twin.walletId));
          dispatch(setWalletNetwork(target));
          dispatch(setWalletType(twin.walletType));
          // A twin may have just been created — refresh the menu's wallet list.
          window.dispatchEvent(new CustomEvent('optn:wallets-changed'));
          navigate(`/home/${twin.walletId}`);
          return;
        }
        // Fell through (legacy saltless wallet / no cached key): drop to picker.
      }

      const existing = isDesktop() ? null : await findWalletForNetwork(target);

      if (existing) {
        // Wallet already exists for this network — load it directly, no re-import
        dispatch(setNetwork(target));
        dispatch(setWalletId(existing.id));
        dispatch(setWalletNetwork(target));
        dispatch(setWalletType(existing.walletType));
        navigate(`/home/${existing.id}`);
      } else {
        // No wallet for this network yet — go to start screen to create/import one
        dispatch(setNetwork(target));
        dispatch(setWalletId(0));
        dispatch(resetUTXOs());
        dispatch(resetTransactions());
        dispatch(resetWallet());
        dispatch(resetContract());
        dispatch(clearTransaction());
        navigate('/');
      }
    } catch (err) {
      console.error('[NetworkSettings] switch failed:', err);
      setSwitching(false);
    }
  };

  const activeEntry = SUPPORTED_NETWORKS.find((n) => n.id === currentNetwork);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs wallet-muted leading-relaxed">
        If you already have a wallet on that network it loads instantly. Otherwise you'll be
        taken to the start screen to create or import one.
      </p>

      <div className="flex flex-col gap-2">
        {SUPPORTED_NETWORKS.map((net) => {
          const isActive = net.id === currentNetwork;
          return (
            <button
              key={net.id}
              type="button"
              onClick={() => void handleSwitch(net.id)}
              disabled={isActive || switching}
              className={`w-full rounded-xl border p-4 text-left transition-colors disabled:cursor-default ${
                isActive
                  ? 'border-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10'
                  : 'border-[var(--wallet-border)] wallet-surface hover:border-[var(--wallet-accent)]/60'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span style={{ color: net.color }} aria-hidden>●</span>
                    <span className="font-semibold wallet-text-strong">{net.label}</span>
                  </div>
                  <p className="text-xs wallet-muted pl-5">{net.description}</p>
                </div>
                {isActive && (
                  <span className="text-xs font-semibold text-[var(--wallet-accent)]">Active</span>
                )}
                {!isActive && switching && (
                  <span className="text-xs wallet-muted animate-pulse">Switching…</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {activeEntry?.showFaucet && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-xs font-semibold wallet-muted uppercase tracking-wide">Chipnet Faucet</p>
          <FaucetView />
        </div>
      )}
    </div>
  );
};
