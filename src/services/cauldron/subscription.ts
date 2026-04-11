import {
  ElectrumClient,
  type ElectrumClientEvents,
  type RequestResponse,
} from '@electrum-cash/network';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';

import { Network } from '../../redux/networkSlice';
import { getCauldronRostrumServers } from './config';
import type { CauldronActivePoolRow } from './api';

type ECClient = ElectrumClient<ElectrumClientEvents>;
type CauldronNotification = {
  jsonrpc?: string;
  method?: string;
  params?: RequestResponse[];
};

type CauldronPoolUpdateCallback = (rows: CauldronActivePoolRow[]) => void;

type CauldronRostrumPoolRow = Record<string, unknown> & {
  is_withdrawn?: unknown;
  new_utxo_hash?: unknown;
  spent_utxo_hash?: unknown;
  token_id?: unknown;
};

const CONNECT_TIMEOUT_MS = 8000;

function parseServerEntry(entry: string, defaultPort = 50004) {
  if (entry.startsWith('ws://') || entry.startsWith('wss://')) {
    const url = new URL(entry);
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === 'wss:' ? 50004 : 50003,
      encrypted: url.protocol === 'wss:',
    };
  }

  const [host, port] = entry.split(':');
  return {
    host,
    port: port ? Number(port) : defaultPort,
    encrypted: true,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function normalizeTokenId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function extractUtxoRows(payload: unknown): CauldronRostrumPoolRow[] {
  if (Array.isArray(payload)) {
    return payload.filter(
      (item): item is CauldronRostrumPoolRow =>
        Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    );
  }

  if (payload && typeof payload === 'object') {
    const candidate = (payload as { utxos?: unknown }).utxos;
    if (Array.isArray(candidate)) {
      return candidate.filter(
        (item): item is CauldronRostrumPoolRow =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
      );
    }
  }

  return [];
}

export class CauldronSubscriptionService {
  private client: ECClient | null = null;
  private connectPromise: Promise<ECClient> | null = null;
  private subscribedTokens = new Set<string>();
  private poolRowsByToken = new Map<string, Map<string, CauldronActivePoolRow>>();
  private listenersByToken = new Map<string, Set<CauldronPoolUpdateCallback>>();
  private network: Network;

  constructor(network: Network) {
    this.network = network;
  }

  private async connect(): Promise<ECClient> {
    if (this.client) return this.client;
    if (this.connectPromise) return this.connectPromise;

    const servers = getCauldronRostrumServers(this.network);
    this.connectPromise = (async () => {
      for (const entry of servers) {
        const { host, port, encrypted } = parseServerEntry(entry);
        const socket = new ElectrumWebSocket(host, port, encrypted, CONNECT_TIMEOUT_MS);
        const client = new ElectrumClient<ElectrumClientEvents>(
          'OPTNWallet-Cauldron',
          '1.0.0',
          socket
        );

        try {
          await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, `connect(${entry})`);
          client.on('notification', (notification: CauldronNotification) =>
            this.handleNotification(notification)
          );
          this.client = client;
          return client;
        } catch {
          try {
            await client.disconnect(true);
          } catch {
            // ignore disconnect errors while failing over
          }
        }
      }

      throw new Error('Unable to connect to any Cauldron Rostrum server.');
    })();

    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private handleNotification(notification: CauldronNotification) {
    if (notification.method !== 'cauldron.contract.subscribe') return;
    this.processSubscriptionPayload(notification.params);
  }

  private processSubscriptionPayload(payload: unknown) {
    let tokenId = '';
    let eventPayload: unknown = payload;

    if (Array.isArray(payload)) {
      tokenId = normalizeTokenId(payload[1]);
      eventPayload = payload[2];
    }

    if (!tokenId && eventPayload && typeof eventPayload === 'object') {
      const utxos = extractUtxoRows(eventPayload);
      tokenId = normalizeTokenId(utxos[0]?.token_id);
    }

    if (!tokenId) return;

    const rows = extractUtxoRows(eventPayload);
    const isInitial =
      Boolean(eventPayload) &&
      typeof eventPayload === 'object' &&
      (eventPayload as { type?: unknown }).type === 'initial';

    const tokenRows = isInitial ? new Map<string, CauldronActivePoolRow>() : (
      this.poolRowsByToken.get(tokenId) ?? new Map<string, CauldronActivePoolRow>()
    );

    for (const row of rows) {
      const spentHash =
        typeof row.spent_utxo_hash === 'string' ? row.spent_utxo_hash.toLowerCase() : '';
      const newHash =
        typeof row.new_utxo_hash === 'string' ? row.new_utxo_hash.toLowerCase() : '';
      const isWithdrawn = row.is_withdrawn === true;

      if (spentHash) {
        tokenRows.delete(spentHash);
      }
      if (!isWithdrawn && newHash) {
        tokenRows.set(newHash, row);
      }
    }

    this.poolRowsByToken.set(tokenId, tokenRows);
    this.emit(tokenId);
  }

  private emit(tokenId: string) {
    const listeners = this.listenersByToken.get(tokenId);
    if (!listeners || listeners.size === 0) return;
    const rows = [...(this.poolRowsByToken.get(tokenId)?.values() ?? [])];
    for (const callback of listeners) {
      callback(rows);
    }
  }

  async subscribe(
    tokenId: string,
    callback: CauldronPoolUpdateCallback
  ): Promise<() => Promise<void>> {
    const normalizedTokenId = normalizeTokenId(tokenId);
    if (!normalizedTokenId) {
      throw new Error('Cauldron live subscription requires a token id.');
    }

    const listeners = this.listenersByToken.get(normalizedTokenId) ?? new Set();
    listeners.add(callback);
    this.listenersByToken.set(normalizedTokenId, listeners);

    const client = await this.connect();
    if (!this.subscribedTokens.has(normalizedTokenId)) {
      const snapshot = await client.request(
        'cauldron.contract.subscribe',
        2,
        normalizedTokenId
      );
      this.processSubscriptionPayload([2, normalizedTokenId, snapshot]);
      await client.subscribe('cauldron.contract.subscribe', 2, normalizedTokenId);
      this.subscribedTokens.add(normalizedTokenId);
    } else {
      this.emit(normalizedTokenId);
    }

    return async () => {
      const current = this.listenersByToken.get(normalizedTokenId);
      current?.delete(callback);

      if (current && current.size > 0) {
        return;
      }

      this.listenersByToken.delete(normalizedTokenId);
      try {
        if (this.client && this.subscribedTokens.has(normalizedTokenId)) {
          await this.client.request(
            'cauldron.contract.unsubscribe',
            2,
            normalizedTokenId
          );
        }
      } catch {
        // ignore unsubscribe failures
      }
      this.subscribedTokens.delete(normalizedTokenId);
      this.poolRowsByToken.delete(normalizedTokenId);
    };
  }

  async disconnect() {
    if (!this.client) return;
    try {
      await this.client.disconnect(true);
    } finally {
      this.client = null;
      this.subscribedTokens.clear();
      this.poolRowsByToken.clear();
      this.listenersByToken.clear();
    }
  }
}

const services = new Map<Network, CauldronSubscriptionService>();

export function getCauldronSubscriptionService(network: Network): CauldronSubscriptionService {
  const existing = services.get(network);
  if (existing) return existing;
  const service = new CauldronSubscriptionService(network);
  services.set(network, service);
  return service;
}
