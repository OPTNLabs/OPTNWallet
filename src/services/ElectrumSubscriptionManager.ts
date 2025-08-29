// src/services/ElectrumSubscriptionManager.ts
import ElectrumServer from '../apis/ElectrumServer/ElectrumServer';
import { AppDispatch } from '../redux/store';
import { updateUTXOsForAddress } from '../redux/utxoSlice';
import ElectrumService from './ElectrumService';

type NotifyHandler = (method: string, params: any[]) => void;

function attachNotification(client: any, handler: NotifyHandler) {
  // Tolerate both shapes: (method, params) and { method, params }
  client.on('notification', (a: any, b?: any) => {
    if (a && typeof a === 'object' && 'method' in a && 'params' in a) {
      handler(a.method, a.params);
    } else if (typeof a === 'string') {
      handler(a, Array.isArray(b) ? b : []);
    }
  });

  // Also hook typed events if the library exposes them
  for (const evt of [
    'blockchain.headers.subscribe',
    'blockchain.address.subscribe',
  ]) {
    // @ts-ignore - best effort; not all builds expose typed events
    if (typeof (client as any).on === 'function') {
      (client as any).on(evt, (...args: any[]) => handler(evt, args));
    }
  }
}

class ElectrumSubscriptionManager {
  private started = false;
  private dispatch: AppDispatch | null = null;
  private watched = new Set<string>();
  private client: any | null = null;

  init(dispatch: AppDispatch) {
    this.dispatch = dispatch;
  }

  /**
   * Start the electrum client + header subscription once for the entire app.
   * Safe to call multiple times; it only starts once.
   */
  async start() {
    if (this.started) return;
    this.started = true;

    this.client = await ElectrumServer().electrumConnect();

    // Subscribe to headers; this also returns immediate tip
    await this.client.subscribe('blockchain.headers.subscribe');

    attachNotification(this.client, (method, params) => {
      if (method === 'blockchain.headers.subscribe' && params?.[0]) {
        // New block found. We refresh UTXOs for all watched addresses so
        // confirmations/settlements are reflected in the UI.
        this.refreshAllWatchedSoon();
      }
      if (method === 'blockchain.address.subscribe') {
        const addr = params?.[0];
        if (addr && this.watched.has(addr)) {
          this.refreshAddressSoon(addr);
        }
      }
    });

    // On reconnects, electrum-cash auto re-subscribes for calls made via .subscribe()
    // We still keep our set so we can re-issue if necessary or add newly watched addresses later.
    this.client.on('connected', async () => {
      // Re-subscribe headers (doc-safe) and all addresses
      try {
        await this.client.subscribe('blockchain.headers.subscribe');
      } catch (e) {
        console.warn('Re-subscribe headers failed:', e);
      }
      for (const a of this.watched) {
        try {
          await this.client.subscribe('blockchain.address.subscribe', a);
        } catch (e) {
          console.warn('Re-subscribe address failed:', a, e);
        }
      }
    });
  }

  /**
   * Add multiple addresses to watch; subscribes any that are new.
   */
  async watchAddresses(addresses: string[]) {
    if (!this.client) await this.start();
    if (!this.client) return;

    for (const a of addresses) {
      if (this.watched.has(a)) continue;
      this.watched.add(a);
      try {
        await this.client.subscribe('blockchain.address.subscribe', a);
        // Pull initial UTXOs so UI is immediately consistent
        this.refreshAddressSoon(a);
      } catch (e) {
        console.error('Subscribe address failed:', a, e);
      }
    }
  }

  /**
   * Add/remove single address if your UI needs dynamic control.
   */
  async addAddress(address: string) {
    return this.watchAddresses([address]);
  }

  async removeAddress(address: string) {
    if (!this.watched.has(address)) return;
    this.watched.delete(address);
    if (this.client) {
      try {
        await this.client.unsubscribe('blockchain.address.subscribe', address);
      } catch (e) {
        console.warn('Unsubscribe address failed:', address, e);
      }
    }
  }

  /**
   * Refresh helpers with debounce to avoid bursts on rapid notifications.
   */
  private refreshTimers = new Map<string, number>();
  private allRefreshTimer: number | null = null;

  private refreshAddressSoon(address: string, ms = 100) {
    const prev = this.refreshTimers.get(address);
    if (prev) clearTimeout(prev);
    const t = window.setTimeout(() => {
      this.refreshAddress(address).catch(console.error);
      this.refreshTimers.delete(address);
    }, ms);
    this.refreshTimers.set(address, t);
  }

  private async refreshAddress(address: string) {
    if (!this.dispatch) return;
    const utxos = await ElectrumService.getUTXOs(address);
    this.dispatch(updateUTXOsForAddress({ address, utxos }));
  }

  private refreshAllWatchedSoon(ms = 200) {
    if (this.allRefreshTimer) clearTimeout(this.allRefreshTimer);
    this.allRefreshTimer = window.setTimeout(() => {
      this.refreshAllWatched().catch(console.error);
      this.allRefreshTimer = null;
    }, ms);
  }

  private async refreshAllWatched() {
    await Promise.all([...this.watched].map((a) => this.refreshAddress(a)));
  }

  /**
   * Optional: stop listening (useful for logout). Generally not needed during normal navigation.
   */
  async stop() {
    if (!this.client) return;
    try {
      // Keep connection for reuse if you want, or close. We avoid unsubscribing so
      // reconnects stay smooth if you start again quickly.
      // If you *must* free resources, uncomment:
      // for (const a of this.watched) await this.client.unsubscribe('blockchain.address.subscribe', a);
      // await this.client.unsubscribe('blockchain.headers.subscribe');
      // await this.client.close();
    } finally {
      // We leave manager ready; if you truly want a cold stop, also clear:
      // this.watched.clear();
    }
  }
}

const manager = new ElectrumSubscriptionManager();
export default manager;
