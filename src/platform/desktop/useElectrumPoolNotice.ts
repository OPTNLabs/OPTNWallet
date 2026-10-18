import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { electrumPool, poolEntries } from './electrumPool';

/**
 * Why this window's Electrum client has no server to use, or null when it
 * has one. Follows the holder's source selection as it changes.
 */
export function useElectrumPoolNotice(network: string): string | null {
  const [notice, setNotice] = useState<{
    network: string;
    reason: string | null;
  } | null>(null);

  useEffect(() => {
    let current = true;
    const check = () => {
      electrumPool(network).then(
        (pool) => {
          if (!current) return;
          const usable = poolEntries(pool).length > 0;
          setNotice({
            network,
            reason: usable
              ? null
              : pool.reason ??
                'The selected Electrum servers use plain TCP, which this screen cannot use.',
          });
        },
        () => {
          if (current) setNotice({ network, reason: null });
        }
      );
    };
    check();
    const unlisten = listen<string>('optn://electrum-pool-changed', (event) => {
      // The pool module drops its copy on the same event; ask again after it.
      if (event.payload === network) setTimeout(check, 0);
    });
    return () => {
      current = false;
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, [network]);

  return notice?.network === network ? notice.reason : null;
}
