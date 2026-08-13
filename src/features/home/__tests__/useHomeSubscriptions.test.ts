import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../useHomeSubscriptions.ts', import.meta.url)),
  'utf8'
);

describe('useHomeSubscriptions initial UTXO ownership', () => {
  it('subscribes without a serial per-address listunspent baseline', () => {
    const subscriptionLoop = source.slice(
      source.indexOf('for (const addr of addrs)'),
      source.indexOf('  }, [', source.indexOf('for (const addr of addrs)'))
    );
    const registration = subscriptionLoop.indexOf(
      'ElectrumService.subscribeAddress(addr'
    );

    expect(registration).toBeGreaterThan(-1);
    expect(subscriptionLoop.slice(0, registration)).not.toContain(
      'ElectrumService.getUTXOs(addr)'
    );
    expect(subscriptionLoop).not.toContain('Home.baselineUTXOs');
  });

  it('keeps subscription-driven UTXO and history updates', () => {
    expect(source).toContain(
      'await ElectrumService.subscribeAddress(addr, async () => {'
    );
    expect(source).toContain('const utxos = await ElectrumService.getUTXOs(addr)');
    expect(source).toContain(
      'dispatch(updateUTXOsForAddress({ address: addr, utxos }))'
    );
    expect(source).toContain('void refreshWalletTransactionHistory({');
  });
});
