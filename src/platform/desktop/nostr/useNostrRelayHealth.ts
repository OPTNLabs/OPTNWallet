import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { invoke } from '@tauri-apps/api/core';
import type { RootState } from '../../../state/store';
import { selectNostrRelays } from '../../../state/slices/experimentalSlice';
import { isDesktopPlatform } from '../../../utils/platform';

type RelayHealth = {
  url: string;
  reachable: boolean | null;
  reason?: string;
};
type RelayHealthReply = { relays: RelayHealth[]; error?: string };

/** Presentation only: native Rust owns policy, probes and the shared short cache. */
export function useNostrRelayHealth() {
  const walletId = useSelector((s: RootState) => s.wallet_id.currentWalletId);
  const network = useSelector((s: RootState) => s.network?.currentNetwork);
  const relays = useSelector(selectNostrRelays);
  const [revision, setRevision] = useState(0);
  const [health, setHealth] = useState<RelayHealthReply>({ relays: [] });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let current = true;
    let pending = false;
    setHealth({ relays: [] });
    setChecking(false);
    if (walletId <= 0 || !network) return;
    if (!isDesktopPlatform()) {
      setHealth({
        relays: [],
        error: 'Native relay checks are unavailable on this platform.',
      });
      return;
    }
    const check = async (force: boolean) => {
      if (pending) return;
      pending = true;
      setChecking(true);
      try {
        const result = await invoke<RelayHealthReply>('nostr_relay_health', {
          relays,
          network,
          force,
        });
        if (current) setHealth(result);
      } catch {
        if (current)
          setHealth({
            relays: [],
            error:
              'Relay checks are unavailable. Your privacy settings are still enforced.',
          });
      } finally {
        pending = false;
        if (current) setChecking(false);
      }
    };
    void check(revision > 0);
    // Rust deduplicates wallet-open and settings requests. Recheck without
    // user intervention when Tor finishes starting or a relay comes back.
    const timer = setInterval(() => void check(false), 30_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [walletId, network, relays, revision]);

  return { health, checking, refresh: () => setRevision((value) => value + 1) };
}
