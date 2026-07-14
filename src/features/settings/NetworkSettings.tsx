import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Network, setNetwork } from '../../state/slices/networkSlice';
import { setWalletNetwork, selectWalletId } from '../../state/slices/walletSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import { AppDispatch } from '../../state/store';
import ElectrumServer from '../../apis/ElectrumServer/ElectrumServer';
import { invalidateUTXOCache } from '../../services/ElectrumService';
import FaucetView from '../../components/FaucetView';

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

export const NetworkSettings: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
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

    // Keep the SAME wallet open — a seed works on both networks (like Cashonize),
    // so there are no duplicate wallets and no lock-out. Flip the network; the
    // reconnect above points balance/history queries at the target network's
    // servers. (Displayed addresses still carry the wallet's original-network
    // prefix — re-encoding them per network is a separate follow-up.)
    dispatch(setNetwork(target));
    if (walletId > 0) dispatch(setWalletNetwork(target));
    setSwitching(false);
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
