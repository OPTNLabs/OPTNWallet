// Copy this file into: src/pages/apps/<your-addon>/ExampleAddonApp.tsx

import { useEffect, useState } from 'react';
import type { AddonSDK } from '../../src/services/AddonsSDK';

type Props = {
  sdk: AddonSDK;
};

export default function ExampleAddonApp({ sdk }: Props) {
  const [status, setStatus] = useState('Loading wallet context...');
  const [walletId, setWalletId] = useState<number | null>(null);
  const [network, setNetwork] = useState<string>('unknown');
  const [addressCount, setAddressCount] = useState<number>(0);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const ctx = sdk.wallet.getContext();
        const addresses = await sdk.wallet.listAddresses();

        if (!mounted) return;

        setWalletId(ctx.walletId);
        setNetwork(String(ctx.network ?? 'unknown'));
        setAddressCount(addresses.length);
        setStatus('Ready');
      } catch (e: unknown) {
        if (!mounted) return;
        setStatus(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      mounted = false;
    };
  }, [sdk]);

  const showSdkInfo = () => {
    const info = sdk.meta.getInfo();
    alert(
      `SDK v${info.version}\n` +
        `Modules: ${info.modules.join(', ')}\n` +
        `Capabilities: ${info.capabilities.join(', ')}`
    );
  };

  return (
    <div className="p-4 space-y-3 wallet-card rounded-2xl">
      <h2 className="text-lg font-semibold">Example Addon App</h2>
      <div className="text-sm wallet-muted">Status: {status}</div>
      <div className="text-sm">Wallet ID: {walletId ?? 'N/A'}</div>
      <div className="text-sm">Network: {network}</div>
      <div className="text-sm">Address count: {addressCount}</div>

      <div className="flex gap-2 pt-2">
        <button className="wallet-btn-secondary" onClick={showSdkInfo}>
          Show SDK Info
        </button>
        <button
          className="wallet-btn-primary"
          onClick={async () => {
            const ok = await sdk.ui.confirmSensitiveAction({
              title: 'Demo confirmation',
              description: 'This demonstrates UI confirmation via SDK.',
              risk: 'low',
            });
            alert(ok ? 'Confirmed' : 'Cancelled');
          }}
        >
          Demo Confirm
        </button>
      </div>
    </div>
  );
}
