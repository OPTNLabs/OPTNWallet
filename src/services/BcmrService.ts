// src/services/BcmrService.ts
import {
  importMetadataRegistry,
  MetadataRegistry,
  IdentitySnapshot,
  IdentityHistory,
  // If you want base64 encoding later:
  // binToBase64,
} from '@bitauth/libauth';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import bcmrLocalJson from '../assets/bcmr-optn-local.json';
import { ipfsFetch, resolveIpfsGatewayUrl } from '../utils/ipfs';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { sha256 } from '../utils/hash';
import { DateTime } from 'luxon';
import { Database } from 'sql.js';
import { BcmrTokenMetadata } from '../types/types';

import { store } from '../state/store';
import { Network } from '../state/slices/networkSlice';
import {
  getBcmrLatestRegistryUrls,
  getBcmrNativeTokenUrls,
  runWithFailover,
} from '../utils/servers/InfraUrls';
import {
  buildTokenLookupUrl,
  BcmrIndexerTokenResponse,
  decodeIconCachePayload,
  dedupeUrls,
  detectImageMimeType,
  encodeIconCachePayload,
  findLatestSnapshotInHistory,
  findSnapshotForCategory,
  getChaingraphOutputHex,
  getNftUrisForCommitment,
  getRegistryIdentity,
  hasIdentityHistory,
  isSyntheticTokenLookupRegistryUri,
  isTokenIndexNativeRegistryUri,
  normalizeHexId,
  normalizeTokenIndexSnapshot,
  TokenIndexBcmrResponse,
} from './bcmr';
import {
  findBcmrOutput,
  parseBcmrOutput,
  resolveAuthChain,
} from './bcmr/authchain';

const ICON_CACHE = new Map<string, string | null>();
const REGISTRY_CACHE = new Map<string, IdentityRegistry>();
const REGISTRY_INFLIGHT = new Map<string, Promise<IdentityRegistry>>();
const REGISTRY_MISS_CACHE = new Map<string, number>();
const REGISTRY_MISS_TTL_MS = 30 * 1000;

export class BcmrRegistryNotFoundError extends Error {
  constructor(
    public readonly authbase: string,
    message = `No BCMR registry found for ${authbase}`
  ) {
    super(message);
    this.name = 'BcmrRegistryNotFoundError';
  }
}

export function isBcmrRegistryNotFoundError(
  error: unknown
): error is BcmrRegistryNotFoundError {
  return error instanceof BcmrRegistryNotFoundError;
}

// ----------------------------------------------------------------------------
// Fallback local registry
// ----------------------------------------------------------------------------
const LOCAL_BCMR = importMetadataRegistry(bcmrLocalJson) as MetadataRegistry;
if (typeof LOCAL_BCMR === 'string') {
  throw new Error('Failed to import local BCMR');
}

function mergeRegistry(registry: MetadataRegistry) {
  if (!registry.identities) return;
  LOCAL_BCMR.identities = LOCAL_BCMR.identities || {};
  for (const authbase of Object.keys(registry.identities)) {
    const localHistory =
      (LOCAL_BCMR.identities as Record<string, IdentityHistory>)[authbase] ||
      {};
    const remoteHistory = registry.identities[authbase]!;
    const merged: IdentityHistory = {
      ...localHistory,
      ...remoteHistory,
    };
    (LOCAL_BCMR.identities as Record<string, IdentityHistory>)[authbase] =
      merged;
  }
  LOCAL_BCMR.version.patch += 1;
  LOCAL_BCMR.latestRevision = new Date().toISOString();
}

// ----------------------------------------------------------------------------
// Custom error to force cache refresh
// ----------------------------------------------------------------------------
// class BcmrRefreshError extends Error {
//   constructor(public uri: string) {
//     super(`Invalidate cache for ${uri}`);
//   }
// }

export interface IdentityRegistry {
  registry: MetadataRegistry;
  registryHash: string;
  registryUri: string;
  lastFetch: string;
}

export default class BcmrService {
  private readonly dbService = DatabaseService();
  private db = this.dbService.getDatabase();
  private CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

  public async getCategoryAuthbase(category: string): Promise<string> {
    const normalizedCategory = normalizeHexId(category);
    const db = await this.getDb();
    const res = db.exec('SELECT authbase FROM bcmr_tokens WHERE category = ?', [
      normalizedCategory,
    ]);
    if (res.length === 0 || res[0].values.length === 0) return normalizedCategory;
    const cols = res[0].columns;
    return res[0].values[0][cols.indexOf('authbase')] as string;
  }

  private async getDb(): Promise<Database> {
    if (!this.db) {
      await this.dbService.ensureDatabaseStarted();
      const db = this.dbService.getDatabase();
      if (!db) throw new Error('Database failed to initialize');
      this.db = db;
    }
    return this.db;
  }

  private getDefaultRegistryUris(authbase: string): string[] {
    const net: Network = store.getState().network.currentNetwork;
    return getBcmrLatestRegistryUrls(net, authbase);
  }

  private getDefaultNativeRegistryUris(category: string): string[] {
    const net: Network = store.getState().network.currentNetwork;
    return getBcmrNativeTokenUrls(net, category);
  }

  private async loadIdentityRegistry(
    authbase: string
  ): Promise<IdentityRegistry> {
    const db = await this.getDb();
    const res = db.exec(
      `SELECT registryUri, lastFetch, registryHash, registryData
         FROM bcmr WHERE authbase = ?`,
      [authbase]
    );
    if (res.length === 0 || res[0].values.length === 0) {
      throw new Error(`No BCMR cache for ${authbase}`);
    }
    const { columns, values } = res[0];
    const row = values[0];
    const registryUri = row[columns.indexOf('registryUri')] as string;
    const lastFetch = row[columns.indexOf('lastFetch')] as string;
    const registryHash = row[columns.indexOf('registryHash')] as string;
    const registryData = row[columns.indexOf('registryData')] as string;
    const imported = importMetadataRegistry(registryData);
    if (typeof imported === 'string') throw new Error(imported);
    mergeRegistry(imported);
    return { registry: imported, registryHash, registryUri, lastFetch };
  }

  private async commitIdentityRegistry(
    authbase: string,
    registry: MetadataRegistry,
    registryUri: string
  ): Promise<IdentityRegistry> {
    const db = await this.getDb();
    const json = JSON.stringify(registry);
    const registryHash = sha256.text(json);
    const lastFetch = new Date().toISOString();
    db.run(
      `INSERT INTO bcmr
         (authbase, registryUri, lastFetch, registryHash, registryData)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(authbase) DO UPDATE SET
         registryUri  = excluded.registryUri,
         lastFetch    = excluded.lastFetch,
         registryHash = excluded.registryHash,
         registryData = excluded.registryData`,
      [authbase, registryUri, lastFetch, registryHash, json]
    );
    mergeRegistry(registry);
    return { registry, registryHash, registryUri, lastFetch };
  }

  public extractIdentity(
    authbase: string,
    registry: MetadataRegistry = LOCAL_BCMR
  ): IdentitySnapshot {
    const normalized = normalizeHexId(authbase);
    const direct = hasIdentityHistory(registry)
      ? findLatestSnapshotInHistory(registry.identities[normalized])
      : null;
    if (direct) {
      return direct;
    }

    const byCategory = findSnapshotForCategory(normalized, registry);
    if (byCategory) {
      return byCategory;
    }

    throw new Error(`No identity history for ${authbase}`);
  }

  public extractIdentityByCategory(
    category: string,
    registry: MetadataRegistry = LOCAL_BCMR
  ): IdentitySnapshot {
    const snapshot = findSnapshotForCategory(category, registry);
    if (!snapshot) {
      throw new Error(`No identity history for token category ${category}`);
    }
    return snapshot;
  }

  /**
   * 1) in-memory?
   * 2) on-disk?
   *     • if stale, trigger a background update but still return the disk copy
   * 3) otherwise fetch & commit (sync)
   */
  private async storeSnapshot(
    authbase: string,
    snapshot: IdentitySnapshot
  ): Promise<void> {
    const db = await this.getDb();
    const category = normalizeHexId(snapshot.token?.category || '');
    if (!category) {
      console.warn('Snapshot missing token.category, cannot store');
      return;
    }
    const name = snapshot.name || '';
    const description = snapshot.description || '';
    const decimals = snapshot.token?.decimals || 0;
    const symbol = snapshot.token?.symbol || '';
    const is_nft = !!snapshot.token?.nfts;
    const is_nft_value = is_nft ? 1 : 0;
    const nfts = snapshot.token?.nfts
      ? JSON.stringify(snapshot.token.nfts)
      : null;
    const uris = snapshot.uris ? JSON.stringify(snapshot.uris) : null;
    const extensions = snapshot.extensions
      ? JSON.stringify(snapshot.extensions)
      : null;

    const query = db.prepare(`
      INSERT OR REPLACE INTO bcmr_metadata (
        category, name, description, decimals, symbol, is_nft, nfts, uris, extensions
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    query.run([
      category,
      name,
      description,
      decimals,
      symbol,
      is_nft_value,
      nfts,
      uris,
      extensions,
    ]);
    query.free();

    // Keep category -> authbase mapping fresh for lookups that start from token category.
    db.run(
      `INSERT OR REPLACE INTO bcmr_tokens (category, authbase) VALUES (?, ?)`,
      [category, normalizeHexId(authbase)]
    );
  }

  private async storeRegistrySnapshots(
    authbase: string,
    registry: MetadataRegistry
  ): Promise<void> {
    if (!hasIdentityHistory(registry)) return;

    const snapshots = Object.values(registry.identities)
      .map((history) => findLatestSnapshotInHistory(history))
      .filter((snapshot): snapshot is IdentitySnapshot => snapshot !== null);

    await Promise.all(
      snapshots.map((snapshot) => this.storeSnapshot(authbase, snapshot))
    );
  }

  public async resolveIdentityRegistry(
    categoryOrAuthbase: string
  ): Promise<IdentityRegistry> {
    const authbase = await this.getCategoryAuthbase(categoryOrAuthbase);

    const cached = REGISTRY_CACHE.get(authbase);
    if (cached && !isSyntheticTokenLookupRegistryUri(cached.registryUri)) {
      return cached;
    }
    const missCachedAt = REGISTRY_MISS_CACHE.get(authbase);
    if (
      missCachedAt !== undefined &&
      Date.now() - missCachedAt < REGISTRY_MISS_TTL_MS
    ) {
      throw new BcmrRegistryNotFoundError(authbase);
    }
    if (missCachedAt !== undefined) {
      REGISTRY_MISS_CACHE.delete(authbase);
    }

    const inflight = REGISTRY_INFLIGHT.get(authbase);
    if (inflight) return inflight;

    const resolution = this.resolveIdentityRegistryUncached(authbase);
    REGISTRY_INFLIGHT.set(authbase, resolution);
    try {
      return await resolution;
    } finally {
      REGISTRY_INFLIGHT.delete(authbase);
    }
  }

  private async resolveIdentityRegistryUncached(
    authbase: string
  ): Promise<IdentityRegistry> {
    const nativeUris = this.getDefaultNativeRegistryUris(authbase);
    const cached = REGISTRY_CACHE.get(authbase);
    if (cached) {
      if (!isTokenIndexNativeRegistryUri(cached.registryUri)) {
        const nativeRefresh = await this.fetchTokenIndexNativeRegistry(
          authbase,
          nativeUris
        );
        if (nativeRefresh) {
          REGISTRY_CACHE.set(authbase, nativeRefresh);
          return nativeRefresh;
        }
      }

      const refreshed = await this.resolveAuthChainRegistry(
        authbase,
        cached.registryUri
      );
      if (refreshed) {
        REGISTRY_CACHE.set(authbase, refreshed);
        return refreshed;
      }
      if (!isSyntheticTokenLookupRegistryUri(cached.registryUri)) {
        return cached;
      }
      const provisionalRefresh = await this.fetchTokenIndexNativeRegistry(
        authbase,
        nativeUris
      );
      if (provisionalRefresh) {
        REGISTRY_CACHE.set(authbase, provisionalRefresh);
        return provisionalRefresh;
      }
      return cached;
    }

    let diskEntry: IdentityRegistry | undefined;
    try {
      diskEntry = await this.loadIdentityRegistry(authbase);
      if (!isTokenIndexNativeRegistryUri(diskEntry.registryUri)) {
        const nativeRefresh = await this.fetchTokenIndexNativeRegistry(
          authbase,
          nativeUris
        );
        if (nativeRefresh) {
          REGISTRY_CACHE.set(authbase, nativeRefresh);
          return nativeRefresh;
        }
      }
      const refreshed = await this.resolveAuthChainRegistry(
        authbase,
        diskEntry.registryUri
      );
      if (refreshed) {
        REGISTRY_CACHE.set(authbase, refreshed);
        return refreshed;
      }
      if (isSyntheticTokenLookupRegistryUri(diskEntry.registryUri)) {
        const provisionalRefresh = await this.fetchTokenIndexNativeRegistry(
          authbase,
          nativeUris
        );
        if (provisionalRefresh) {
          REGISTRY_CACHE.set(authbase, provisionalRefresh);
          return provisionalRefresh;
        }
      }
      mergeRegistry(diskEntry.registry);
      REGISTRY_CACHE.set(authbase, diskEntry);

      try {
        await this.storeRegistrySnapshots(authbase, diskEntry.registry);
      } catch (err) {
        console.warn(
          `Failed to store snapshot for ${authbase} from disk:`,
          err
        );
      }

      const age =
        DateTime.now().toMillis() -
        DateTime.fromISO(diskEntry.lastFetch).toMillis();
      if (age >= this.CACHE_TTL_MS) {
        this.backgroundRefresh(authbase, diskEntry.registryUri);
      }
      return diskEntry;
    } catch {
      // No local cache, fall through
    }

    const uris = this.getDefaultRegistryUris(authbase);
    let fresh: IdentityRegistry;
    try {
      const native = await this.fetchTokenIndexNativeRegistry(authbase, nativeUris);
      if (native) {
        REGISTRY_CACHE.set(authbase, native);
        REGISTRY_MISS_CACHE.delete(authbase);
        fresh = native;
      } else {
        fresh = await this.fetchAndCommitRegistry(authbase, uris);
      }
    } catch (err) {
      // If all indexer endpoints fail, try resolving directly from authchain BCMR OP_RETURN.
      const onChain = await this.resolveAuthChainRegistry(authbase, uris[0] || '');
      if (!onChain) {
        if (this.isMissingRegistryError(err)) {
          REGISTRY_MISS_CACHE.set(authbase, Date.now());
          throw new BcmrRegistryNotFoundError(authbase);
        }
        throw err;
      }
      fresh = onChain;
      REGISTRY_CACHE.set(authbase, fresh);
    }

    try {
      await this.storeRegistrySnapshots(authbase, fresh.registry);
    } catch (err) {
      // console.warn(`Failed to store snapshot for ${authbase} from fetch:`, err);
    }

    return fresh;
  }

  private async fetchTokenIndexNativeRegistry(
    authbase: string,
    uriOrUris: string | string[]
  ): Promise<IdentityRegistry | null> {
    const uris = Array.isArray(uriOrUris) ? uriOrUris : [uriOrUris];
    const net: Network = store.getState().network.currentNetwork;

    try {
      return await runWithFailover(
        `bcmr-native:${net}:${authbase}`,
        uris,
        async (uri): Promise<IdentityRegistry> => {
          const resp = await ipfsFetch(uri);
          if (!resp.ok) {
            throw new Error(`Fetch failed: HTTP ${resp.status}`);
          }

          let data: TokenIndexBcmrResponse;
          try {
            data = (await resp.json()) as TokenIndexBcmrResponse;
          } catch {
            throw new Error(`Invalid JSON response from ${uri}`);
          }

          const imported = normalizeTokenIndexSnapshot(authbase, data);
          if (!imported) {
            throw new Error(`Invalid tokenindex BCMR response from ${uri}`);
          }

          const committed = await this.commitIdentityRegistry(
            normalizeHexId(authbase),
            imported,
            uri
          );
          REGISTRY_CACHE.set(authbase, committed);
          REGISTRY_MISS_CACHE.delete(authbase);
          return committed;
        }
      );
    } catch {
      return null;
    }
  }

  public async getSnapshot(
    category: string
  ): Promise<BcmrTokenMetadata | null> {
    const normalizedCategory = normalizeHexId(category);
    const db = await this.getDb();
    const query = db.prepare('SELECT * FROM bcmr_metadata WHERE category = ?');
    query.bind([normalizedCategory]);
    if (query.step()) {
      const row = query.getAsObject();
      query.free();
      return {
        name: row.name as string,
        description: row.description as string,
        token: {
          category: row.category as string,
          symbol: row.symbol as string,
          decimals: row.decimals as number,
        },
        is_nft: row.is_nft === 1,
        nfts: row.nfts ? JSON.parse(row.nfts as string) : undefined,
        uris: row.uris ? JSON.parse(row.uris as string) : undefined,
        extensions: row.extensions
          ? JSON.parse(row.extensions as string)
          : undefined,
      };
    }
    query.free();
    return null;
  }

  // ----------------------------------------------------------------------------
  // Chain‐resolution via Chaingraph
  // ----------------------------------------------------------------------------

  /**
   * 1) Ask Chaingraph for the authHead txid
   * 2) Walk backwards through candidate authchain spends until the latest BCMR publication
   */
  private async resolveAuthChainRegistry(
    authbase: string,
    fallbackUri: string
  ): Promise<IdentityRegistry | null> {
    try {
      const chain = await resolveAuthChain(authbase);
      for (const tx of chain) {
        const out = findBcmrOutput(tx);
        if (!out) continue;

        const { hash, uris } = parseBcmrOutput(
          getChaingraphOutputHex(out)
        );
        const candidateUris = dedupeUrls([...uris, fallbackUri].filter(Boolean));

        for (const uri of candidateUris) {
          const resp = await ipfsFetch(uri);
          if (!resp.ok) continue;

          const body = await resp.text();
          if (sha256.text(body) !== hash.toLowerCase()) {
            continue;
          }

          let data: unknown;
          try {
            data = JSON.parse(body);
          } catch {
            continue;
          }

          const imported = importMetadataRegistry(data);
          if (typeof imported === 'string') continue;
          return this.commitIdentityRegistry(authbase, imported, uri);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  public async preloadMetadataRegistries(): Promise<IdentityRegistry[]> {
    const db = await this.getDb();
    const res = db.exec(`SELECT authbase FROM bcmr;`);
    if (res.length === 0) return [];
    const cols = res[0].columns;
    const idx = cols.indexOf('authbase');
    return Promise.all(
      res[0].values.map((row) => this.loadIdentityRegistry(row[idx] as string))
    );
  }

  /**
   * Wipe all on-chain registry caches (both the registry table and the mapping table)
   */
  public async purgeBcmrData(): Promise<void> {
    const db = await this.getDb();
    db.run(`DELETE FROM bcmr; DELETE FROM bcmr_tokens;`);
    await this.dbService.flushDatabaseToFile();
  }

  /**
   * Return the full in-memory “local” registry (including any merges you’ve done)
   */
  public exportLocalBcmr(): MetadataRegistry {
    return LOCAL_BCMR;
  }

  /**
   * Fetch an identity or NFT‐type icon via IPFS, with on-device caching via Capacitor Filesystem.
   */
  public async resolveIcon(
    authbase: string,
    nftCommitment?: string,
    category?: string
  ): Promise<string | null> {
    // pick the right URI map
    const snapshot = category
      ? this.extractIdentityByCategory(category)
      : this.extractIdentity(authbase);
    const uris = nftCommitment
      ? getNftUrisForCommitment(snapshot, nftCommitment)
      : snapshot.uris;
    const iconUri = uris?.icon;
    if (!iconUri) return null;

    if (
      iconUri.startsWith('http://') ||
      iconUri.startsWith('https://') ||
      iconUri.startsWith('data:') ||
      iconUri.startsWith('blob:') ||
      iconUri.startsWith('/')
    ) {
      return iconUri;
    }

    // use hash of authbase or authbase+nft as filename
    const filename = nftCommitment
      ? sha256.text(`${authbase}${nftCommitment}`)
      : authbase;
    const filePath = `optn/icons/${filename}`;

    // 1) in-memory cache
    if (ICON_CACHE.has(filePath)) {
      return ICON_CACHE.get(filePath);
    }

    // 2) try reading from filesystem cache
    try {
      const read = await Filesystem.readFile({
        path: filePath,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      });
      if (typeof read.data !== 'string') {
        throw new Error('Unexpected cached icon payload type.');
      }
      const dataUri = decodeIconCachePayload(read.data).dataUri;
      ICON_CACHE.set(filePath, dataUri);
      return dataUri;
    } catch {
      // not on disk yet
    }

    // 3) fetch from IPFS
    let resp: Response;
    try {
      resp = await ipfsFetch(iconUri);
    } catch {
      const gatewayUri = resolveIpfsGatewayUrl(iconUri);
      ICON_CACHE.set(filePath, gatewayUri);
      return gatewayUri;
    }
    if (!resp.ok) {
      const gatewayUri = resolveIpfsGatewayUrl(iconUri);
      ICON_CACHE.set(filePath, gatewayUri);
      return gatewayUri;
    }

    let buf: Uint8Array;
    try {
      buf = new Uint8Array(await resp.arrayBuffer());
    } catch {
      ICON_CACHE.set(filePath, null);
      return null;
    }
    const { binToBase64 } = await import('@bitauth/libauth');
    const b64 = binToBase64(buf);
    const contentType = detectImageMimeType(buf, resp.headers.get('content-type'));
    const dataUri = `data:${contentType};base64,${b64}`;

    // 4) write to filesystem cache for next time
    try {
      await Filesystem.writeFile({
        path: filePath,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
        data: encodeIconCachePayload(b64, contentType),
      });
    } catch {
      // ignore write errors
    }

    ICON_CACHE.set(filePath, dataUri);
    return dataUri;
  }

  /**
   * Persist any pending BCMR cache updates to disk.
   * Call this once when your app finishes initializing all metadata.
   */
  public async flushCache(): Promise<void> {
    await this.dbService.flushDatabaseToFile();
  }

  // A little helper that actually fetches & commits one registry:
  private async fetchAndCommitRegistry(
    authbase: string,
    uriOrUris: string | string[]
  ): Promise<IdentityRegistry> {
    const uris = Array.isArray(uriOrUris) ? uriOrUris : [uriOrUris];
    const net: Network = store.getState().network.currentNetwork;

    const onChain = await this.resolveAuthChainRegistry(authbase, uris[0] || '');
    if (onChain) {
      REGISTRY_CACHE.set(authbase, onChain);
      REGISTRY_MISS_CACHE.delete(authbase);
      return onChain;
    }

    return runWithFailover(
      `bcmr:${net}:${authbase}`,
      uris,
      async (uri): Promise<IdentityRegistry> => {
        const resp = await ipfsFetch(uri);
        if (!resp.ok) {
          if (resp.status === 404) {
            const onChain = await this.resolveAuthChainRegistry(authbase, uri);
            if (onChain) {
              REGISTRY_CACHE.set(authbase, onChain);
              REGISTRY_MISS_CACHE.delete(authbase);
              return onChain;
            }
            const fallback = await this.fetchIndexerTokenFallback(authbase, uri);
            if (fallback) {
              REGISTRY_CACHE.set(authbase, fallback);
              REGISTRY_MISS_CACHE.delete(authbase);
              return fallback;
            }
          }
          throw new Error(`Fetch failed: HTTP ${resp.status}`);
        }

        let data;
        try {
          data = await resp.json();
        } catch {
          throw new Error(`Invalid JSON response from ${uri}`);
        }

        const imported = importMetadataRegistry(data);
        if (typeof imported === 'string') {
          const onChain = await this.resolveAuthChainRegistry(authbase, uri);
          if (onChain) {
            REGISTRY_CACHE.set(authbase, onChain);
            return onChain;
          }
          const fallback = await this.fetchIndexerTokenFallback(authbase, uri);
          if (fallback) {
            REGISTRY_CACHE.set(authbase, fallback);
            return fallback;
          }
          throw new Error(imported);
        }

        // on-chain fallback
        const registryIdentity = getRegistryIdentity(imported);
        if (registryIdentity) {
          const onChain = await this.resolveAuthChainRegistry(
            registryIdentity,
            uri
          );
          if (onChain) {
            REGISTRY_CACHE.set(authbase, onChain);
            return onChain;
          }
        }

        // commit to sqlite
        const committed = await this.commitIdentityRegistry(
          authbase,
          imported,
          uri
        );
        REGISTRY_CACHE.set(authbase, committed);
        REGISTRY_MISS_CACHE.delete(authbase);
        return committed;
      }
    );
  }

  private async fetchIndexerTokenFallback(
    authbase: string,
    registryUrl: string
  ): Promise<IdentityRegistry | null> {
    const tokenUrl = buildTokenLookupUrl(registryUrl, authbase);
    if (!tokenUrl) return null;

    const resp = await ipfsFetch(tokenUrl);
    if (!resp.ok) return null;

    let tokenData: BcmrIndexerTokenResponse;
    try {
      tokenData = (await resp.json()) as BcmrIndexerTokenResponse;
    } catch {
      return null;
    }

    const category = normalizeHexId(tokenData?.token?.category || authbase);
    const symbol = String(tokenData?.token?.symbol || '').trim();
    const decimals = Number.isFinite(tokenData?.token?.decimals)
      ? Math.max(0, Math.trunc(Number(tokenData?.token?.decimals)))
      : 0;
    const name = String(tokenData?.name || '').trim() || category;
    const description = String(tokenData?.description || '').trim() || undefined;
    const uris = tokenData?.uris && Object.keys(tokenData.uris).length > 0
      ? tokenData.uris
      : undefined;

    const latestRevision = new Date().toISOString();
    const synthetic = {
      $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
      version: { major: 0, minor: 0, patch: 0 },
      latestRevision,
      registryIdentity: normalizeHexId(authbase),
      identities: {
        [normalizeHexId(authbase)]: {
          [latestRevision]: {
            name,
            description,
            token: {
              category,
              symbol,
              decimals,
            },
            uris,
            extensions: tokenData.extensions,
          },
        },
      },
    };

    const imported = importMetadataRegistry(synthetic);
    if (typeof imported === 'string') return null;

    return this.commitIdentityRegistry(normalizeHexId(authbase), imported, tokenUrl);
  }

  public async resolveCategorySpecificRegistry(
    category: string
  ): Promise<IdentityRegistry | null> {
    const normalizedCategory = normalizeHexId(category);
    if (!normalizedCategory) return null;

    const uris = this.getDefaultRegistryUris(normalizedCategory);
    try {
      return await runWithFailover(
        `bcmr-category:${normalizedCategory}`,
        uris,
        async (uri): Promise<IdentityRegistry> => {
          const resp = await ipfsFetch(uri);
          if (!resp.ok) {
            if (resp.status === 404) {
              const fallback = await this.fetchIndexerTokenFallback(
                normalizedCategory,
                uri
              );
              if (fallback) return fallback;
            }
            throw new Error(`Fetch failed: HTTP ${resp.status}`);
          }

          let data: unknown;
          try {
            data = await resp.json();
          } catch {
            throw new Error(`Invalid JSON response from ${uri}`);
          }

          const imported = importMetadataRegistry(data);
          if (typeof imported === 'string') {
            const fallback = await this.fetchIndexerTokenFallback(
              normalizedCategory,
              uri
            );
            if (fallback) return fallback;
            throw new Error(imported);
          }

          return this.commitIdentityRegistry(normalizedCategory, imported, uri);
        }
      );
    } catch {
      return null;
    }
  }

  private async backgroundRefresh(
    authbase: string,
    uri: string
  ): Promise<void> {
    try {
      const uris = dedupeUrls([uri, ...this.getDefaultRegistryUris(authbase)]);
      await this.fetchAndCommitRegistry(authbase, uris);
    } catch (err) {
      if (this.isMissingRegistryError(err)) return;
      console.error('BCMR background refresh failed', err);
    }
  }

  private isMissingRegistryError(error: unknown): boolean {
    if (isBcmrRegistryNotFoundError(error)) return true;
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('HTTP 404');
  }
}
