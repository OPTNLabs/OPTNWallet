import ElectrumServer from '../../apis/ElectrumServer/ElectrumServer';

type BlockHeaderCallback = (header: unknown) => void;

const subscriptionRegistry: Record<string, Map<string, (data: unknown) => void>> = {
  'blockchain.address.subscribe': new Map(),
  'blockchain.headers.subscribe': new Map(),
  'blockchain.transaction.subscribe': new Map(),
  'blockchain.transaction.dsproof.subscribe': new Map(),
};

const blockHeaderListeners = new Set<BlockHeaderCallback>();
let latestBlockHeader: unknown = null;
let routerInstalled = false;

async function ensureNotificationRouter() {
  if (routerInstalled) return;

  const { onNotification } = ElectrumServer();
  onNotification((n) => {
    const { method, params } = n;
    const registry = subscriptionRegistry[method];
    if (!registry) return;

    if (method === 'blockchain.headers.subscribe') {
      const header = params?.[0];
      latestBlockHeader = header;
      for (const cb of blockHeaderListeners) {
        cb(header);
      }
      return;
    }

    const key = String(params?.[0] ?? '');
    const data = params?.[1];
    const cb = registry.get(key);
    if (cb) cb(data);
  });

  routerInstalled = true;
}

export async function registerAddressSubscription(
  address: string,
  callback: (status: string) => void
): Promise<boolean> {
  const reg = subscriptionRegistry['blockchain.address.subscribe'];
  if (!reg.has(address)) {
    await ElectrumServer().subscribe('blockchain.address.subscribe', [address]);
    await ensureNotificationRouter();
  }
  reg.set(address, callback);
  return true;
}

/**
 * Bulk-register address subscriptions in a single batched round-trip.
 * Returns the list of addresses that were newly subscribed.
 *
 * Callback is **per address** (Selene-style). A shared callback that refreshed
 * every subscribed address on any one notify was re-corrupting balances after
 * Manual Sync.
 */
export async function registerAddressSubscriptionsBulk(
  addresses: string[],
  callback?: (address: string, status: string) => void
): Promise<string[]> {
  if (addresses.length === 0) return [];

  const reg = subscriptionRegistry['blockchain.address.subscribe'];
  const fresh = addresses.filter((addr) => !reg.has(addr));
  if (fresh.length === 0) return [];

  await ensureNotificationRouter();
  await ElectrumServer().subscribeMany(
    'blockchain.address.subscribe',
    fresh.map((addr) => [addr])
  );

  for (const addr of fresh) {
    reg.set(addr, (data: unknown) => {
      callback?.(addr, String(data ?? ''));
    });
  }
  return fresh;
}

export async function registerTransactionSubscription(
  txHash: string,
  callback: (height: number) => void
): Promise<boolean> {
  const reg = subscriptionRegistry['blockchain.transaction.subscribe'];
  if (!reg.has(txHash)) {
    await ElectrumServer().subscribe('blockchain.transaction.subscribe', [txHash]);
    await ensureNotificationRouter();
  }
  reg.set(txHash, callback);
  return true;
}

export async function registerDoubleSpendProofSubscription(
  txHash: string,
  callback: (ds: unknown) => void
): Promise<boolean> {
  const reg = subscriptionRegistry['blockchain.transaction.dsproof.subscribe'];
  if (!reg.has(txHash)) {
    await ElectrumServer().subscribe('blockchain.transaction.dsproof.subscribe', [
      txHash,
    ]);
    await ensureNotificationRouter();
  }
  reg.set(txHash, callback);
  return true;
}

export async function registerBlockHeaderListener(
  callback: (header: unknown) => void
): Promise<unknown> {
  const shouldSubscribe = blockHeaderListeners.size === 0;
  blockHeaderListeners.add(callback);
  subscriptionRegistry['blockchain.headers.subscribe'].set('tip', () => undefined);
  if (shouldSubscribe) {
    await ElectrumServer().subscribe('blockchain.headers.subscribe');
    await ensureNotificationRouter();
  }

  if (latestBlockHeader !== null) {
    return latestBlockHeader;
  }
  return null;
}

export function unregisterAddressSubscription(address: string): void {
  subscriptionRegistry['blockchain.address.subscribe'].delete(address);
}

export function unregisterTransactionSubscription(txHash: string): void {
  subscriptionRegistry['blockchain.transaction.subscribe'].delete(txHash);
}

export function unregisterDoubleSpendProofSubscription(txHash: string): void {
  subscriptionRegistry['blockchain.transaction.dsproof.subscribe'].delete(txHash);
}

export async function clearBlockHeaderListeners(
  callback?: (header: unknown) => void
): Promise<boolean> {
  if (callback) {
    blockHeaderListeners.delete(callback);
  } else {
    blockHeaderListeners.clear();
  }
  if (blockHeaderListeners.size === 0) {
    await ElectrumServer().unsubscribe('blockchain.headers.subscribe');
    subscriptionRegistry['blockchain.headers.subscribe'].delete('tip');
    latestBlockHeader = null;
  }
  return true;
}

export function setLatestBlockHeader(header: unknown): void {
  latestBlockHeader = header;
}
