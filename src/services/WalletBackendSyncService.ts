import KeyService from './KeyService';
import WalletManager from '../apis/WalletManager/WalletManager';
import { Network } from '../redux/networkSlice';
import { WalletType } from '../types/wallet';

type BackendRegistrationPayload = {
  account_id?: string;
  installation_id: string;
  device_id?: string;
  coin_family: 'bch';
  network: 'mainnet' | 'chipnet';
  profile_version: number;
  receive_xpub: string;
  change_xpub: string;
  gap_limit: number;
  active_window: number;
};

type BackendRegistrationResponse = {
  ok?: boolean;
  account_id?: string;
};

type BackendObserveResponse = {
  ok?: boolean;
};

export type BackendNotificationKind =
  | 'incoming_bch'
  | 'incoming_token'
  | 'transaction_confirmed';

export type BackendNotification = {
  account_id: string;
  installation_id: string;
  txid: string;
  kind: BackendNotificationKind;
  block_height: number | null;
  address: string | null;
  token_category: string | null;
  dedupe_key: string;
};

const INSTALLATION_ID_KEY = 'optn_wallet_backend_installation_id_v1';
const ACCOUNT_ID_KEY_PREFIX = 'optn_wallet_backend_account_id_v1:';
const BACKEND_URL_KEY = 'VITE_OPTN_WALLET_BACKEND_URL';

function readEnv(key: string): string | undefined {
  try {
    type ImportMetaWithEnv = ImportMeta & {
      env?: Record<string, string | undefined>;
    };
    const env = (import.meta as ImportMetaWithEnv).env;
    if (typeof import.meta !== 'undefined' && env?.[key]) {
      return String(env[key]);
    }
  } catch {
    // best effort
  }
  return undefined;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function getBackendBaseUrl(): string | null {
  const raw = readEnv(BACKEND_URL_KEY);
  if (!raw) {
    return import.meta.env.DEV ? 'http://127.0.0.1:8787' : null;
  }
  const normalized = normalizeBaseUrl(raw);
  return normalized.length > 0 ? normalized : null;
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  let hash = 0;
  for (const char of input) {
    hash = (hash << 5) - hash + char.charCodeAt(0);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // best effort
  }
}

function getInstallationId(): string {
  const existing = readStorage(INSTALLATION_ID_KEY);
  if (existing) return existing;
  const next = randomId();
  writeStorage(INSTALLATION_ID_KEY, next);
  return next;
}

async function getAccountId(
  network: Network,
  receiveXpub: string,
  changeXpub: string
): Promise<string> {
  const fingerprint = await sha256Hex(`${network}:${receiveXpub}:${changeXpub}`);
  return `acct_${fingerprint.slice(0, 24)}`;
}

function getNetworkLabel(network: Network): 'mainnet' | 'chipnet' {
  return network === Network.MAINNET ? 'mainnet' : 'chipnet';
}

function getAccountStorageKey(network: Network, receiveXpub: string, changeXpub: string): string {
  return `${ACCOUNT_ID_KEY_PREFIX}${network}:${receiveXpub.slice(0, 16)}:${changeXpub.slice(0, 16)}`;
}

async function buildRegistrationPayload(walletId: number): Promise<BackendRegistrationPayload | null> {
  const walletManager = WalletManager();
  const walletInfo = await walletManager.getWalletInfo(walletId);
  if (!walletInfo) {
    return null;
  }

  const network =
    walletInfo.networkType === Network.MAINNET ? Network.MAINNET : Network.CHIPNET;
  const xpubs = await KeyService.getWalletXpubs(walletId, 0);
  const receiveXpub = xpubs.receive;
  const changeXpub = xpubs.change;
  if (!receiveXpub || !changeXpub) {
    return null;
  }

  const installationId = getInstallationId();
  const storageKey = getAccountStorageKey(network, receiveXpub, changeXpub);
  const storedAccountId = readStorage(storageKey) || undefined;
  const accountId = storedAccountId || (await getAccountId(network, receiveXpub, changeXpub));

  return {
    account_id: accountId,
    installation_id: installationId,
    coin_family: 'bch',
    network: getNetworkLabel(network),
    profile_version: walletInfo.walletType === WalletType.QUANTUMROOT ? 2 : 1,
    receive_xpub: receiveXpub,
    change_xpub: changeXpub,
    gap_limit: 20,
    active_window: 20,
  };
}

async function buildContext(walletId: number): Promise<{
  baseUrl: string;
  accountId: string;
  installationId: string;
} | null> {
  const baseUrl = getBackendBaseUrl();
  if (!baseUrl) return null;

  const payload = await buildRegistrationPayload(walletId);
  if (!payload) return null;

  return {
    baseUrl,
    accountId: payload.account_id ?? '',
    installationId: payload.installation_id,
  };
}

async function postJson(url: string, body: unknown): Promise<BackendRegistrationResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Backend registration failed with status ${response.status}`);
  }

  return (await response.json()) as BackendRegistrationResponse;
}

async function postJsonAny<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

async function pingHealth(url: string): Promise<void> {
  const response = await fetch(`${url}/health`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Backend health check failed with status ${response.status}`);
  }
}

const WalletBackendSyncService = {
  async getWalletContext(walletId: number): Promise<{
    baseUrl: string;
    accountId: string;
    installationId: string;
  } | null> {
    try {
      return await buildContext(walletId);
    } catch {
      return null;
    }
  },

  async registerWallet(walletId: number): Promise<void> {
    const baseUrl = getBackendBaseUrl();
    if (!baseUrl) return;

    try {
      await pingHealth(baseUrl);
      const payload = await buildRegistrationPayload(walletId);
      if (!payload) return;

      const accountStorageKey = getAccountStorageKey(
        payload.network === 'mainnet' ? Network.MAINNET : Network.CHIPNET,
        payload.receive_xpub,
        payload.change_xpub
      );

      const response = await postJson(`${baseUrl}/wallets`, payload);
      if (response.account_id) {
        writeStorage(accountStorageKey, response.account_id);
      }
    } catch (error) {
      console.warn('Wallet backend registration failed:', error);
    }
  },

  async listNotifications(walletId: number): Promise<BackendNotification[]> {
    try {
      const context = await buildContext(walletId);
      if (!context || !context.accountId) return [];
      const response = await getJson<{ ok?: boolean; notifications?: BackendNotification[] }>(
        `${context.baseUrl}/wallets/${encodeURIComponent(context.accountId)}/${encodeURIComponent(context.installationId)}/notifications?limit=20`
      );
      return response.notifications ?? [];
    } catch {
      return [];
    }
  },

  async observeTransaction(walletId: number, txid: string, rawTx: string): Promise<void> {
    try {
      const context = await buildContext(walletId);
      if (!context || !context.accountId) return;
      await postJsonAny<BackendObserveResponse>(
        `${context.baseUrl}/events/observe`,
        {
          account_id: context.accountId,
          installation_id: context.installationId,
          txid,
          raw_tx: rawTx,
        }
      );
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('Wallet backend observeTransaction failed:', error);
      }
    }
  },
};

export default WalletBackendSyncService;
