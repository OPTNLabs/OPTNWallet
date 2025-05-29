// src/services/BcmrService.ts
import {
  importMetadataRegistry,
  MetadataRegistry,
  IdentitySnapshot,
  RegistryTimestampKeyedValues,
  IdentityHistory,
  // If you want base64 encoding later:
  // binToBase64,
} from '@bitauth/libauth';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import {
  queryAuthHead,
  queryTransactionByHash,
} from '../apis/ChaingraphManager/ChaingraphManager';
import bcmrLocalJson from '../assets/bcmr-optn-local.json';
import { ipfsFetch } from '../utils/ipfs';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { sha256 } from '../utils/hash';
import { DateTime } from 'luxon';
import { Database } from 'sql.js';

const ICON_CACHE = new Map<string, string | null>();

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
    // both of these are timestamp→IdentitySnapshot maps
    const localHistory =
      (LOCAL_BCMR.identities as Record<string, IdentityHistory>)[authbase] ||
      {};
    const remoteHistory = registry.identities[authbase]!; // also IdentityHistory
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
  private db = DatabaseService().getDatabase();
  private CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

  private inMemoryRegistries = new Map<string, IdentityRegistry>();

  public async getCategoryAuthbase(category: string): Promise<string> {
    const db = await this.getDb();
    const res = db.exec('SELECT authbase FROM bcmr_tokens WHERE category = ?', [
      category,
    ]);
    if (res.length === 0 || res[0].values.length === 0) return category;
    const cols = res[0].columns;
    return res[0].values[0][cols.indexOf('authbase')] as string;
  }

  private async getDb(): Promise<Database> {
    if (!this.db) {
      await DatabaseService().ensureDatabaseStarted();
      const db = DatabaseService().getDatabase();
      if (!db) throw new Error('Database failed to initialize');
      this.db = db;
    }
    return this.db;
  }

  private getDefaultRegistryUri(authbase: string): string {
    return `https://bcmr.paytaca.com/api/registries/${authbase}/latest`;
  }

  private async loadIdentityRegistry(
    authbase: string
  ): Promise<IdentityRegistry> {
    const res = this.db.exec(
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
    const json = JSON.stringify(registry);
    const registryHash = sha256.text(json);
    const lastFetch = new Date().toISOString();
    this.db.run(
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
    const history = (registry as any).identities?.[
      authbase
    ] as RegistryTimestampKeyedValues<IdentitySnapshot>;
    if (!history) {
      throw new Error(`No identity history for ${authbase}`);
    }
    const ts = Object.keys(history).sort().reverse();
    return history[ts[0]];
  }

  /**
   * 1) in-memory?
   * 2) on-disk?
   *     • if stale, trigger a background update but still return the disk copy
   * 3) otherwise fetch & commit (sync)
   */
  public async resolveIdentityRegistry(
    categoryOrAuthbase: string
  ): Promise<IdentityRegistry> {
    const authbase = await this.getCategoryAuthbase(categoryOrAuthbase);

    // 1. fast in-memory
    const cached = this.inMemoryRegistries.get(authbase);
    if (cached) return cached;

    // 2. try load from sqlite
    let diskEntry: IdentityRegistry | undefined;
    try {
      diskEntry = await this.loadIdentityRegistry(authbase);
      mergeRegistry(diskEntry.registry);
      this.inMemoryRegistries.set(authbase, diskEntry);

      // if >7d old, refresh in background
      const age =
        DateTime.now().toMillis() -
        DateTime.fromISO(diskEntry.lastFetch).toMillis();
      if (age >= this.CACHE_TTL_MS) {
        this.backgroundRefresh(authbase, diskEntry.registryUri);
      }
      return diskEntry;
    } catch {
      // no local cache, fall through
    }

    // 3. first-time or completely missing → must fetch & commit synchronously
    const uri = this.getDefaultRegistryUri(authbase);
    const fresh = await this.fetchAndCommitRegistry(authbase, uri);
    return fresh;
  }

  // ----------------------------------------------------------------------------
  // Chain‐resolution via Chaingraph
  // ----------------------------------------------------------------------------

  /**
   * 1) Ask Chaingraph for the authHead txid
   * 2) Fetch that single transaction’s outputs
   */
  private async resolveAuthChain(authbase: string): Promise<any[]> {
    // 1) get the head of the authchain
    const authHeadData = await queryAuthHead(authbase);
    const headHash =
      authHeadData?.data?.transaction?.[0]?.authchains?.[0]?.authhead
        ?.identity_output?.[0]?.transaction_hash;
    if (!headHash) {
      throw new Error(`No authHead for ${authbase}`);
    }

    // 2) fetch the full tx
    const txResp = await queryTransactionByHash(headHash);
    const tx = txResp?.data?.transaction?.[0];
    if (!tx) {
      throw new Error(`Chaingraph missing transaction ${headHash}`);
    }
    return [tx];
  }

  private findBcmrOutput(tx: any): any | null {
    return (
      tx.outputs?.find((o: any) =>
        o.scriptPubKey.hex.startsWith('6a0442434d52')
      ) || null
    );
  }

  private parseBcmrOutput(voutHex: string): { hash: string; uris: string[] } {
    let cursor = voutHex.indexOf('6a0442434d52');
    cursor += '6a0442434d52'.length;
    cursor += 2; // OP_PUSHBYTES_32
    const hash = voutHex.slice(cursor, cursor + 64);
    cursor += 64;
    const uris: string[] = [];
    while (cursor < voutHex.length) {
      const pushOp = voutHex.slice(cursor, cursor + 2);
      cursor += 2;
      let len = parseInt(pushOp, 16) * 2;
      if (pushOp === '4c') {
        len = parseInt(voutHex.slice(cursor, cursor + 2), 16) * 2;
        cursor += 2;
      }
      // TODO: 4d/4e if you expect >75-byte URIs
      const uriHex = voutHex.slice(cursor, cursor + len);
      cursor += len;
      uris.push(Buffer.from(uriHex, 'hex').toString('utf8'));
    }
    return { hash, uris };
  }

  private async resolveAuthChainRegistry(
    authbase: string,
    fallbackUri: string
  ): Promise<IdentityRegistry | null> {
    try {
      const chain = await this.resolveAuthChain(authbase);
      let latest: any = null;
      for (const tx of chain) {
        const out = this.findBcmrOutput(tx);
        if (out) latest = out;
      }
      if (!latest) return null;
      const { uris } = this.parseBcmrOutput(latest.scriptPubKey.hex);
      const uri = uris[0] || fallbackUri;
      const resp = await ipfsFetch(uri);
      if (!resp.ok) throw new Error(`Failed ${uri}`);
      const data = await resp.json();
      const imported = importMetadataRegistry(data);
      if (typeof imported === 'string') throw new Error(imported);
      return this.commitIdentityRegistry(authbase, imported, uri);
    } catch {
      return null;
    }
  }

  public async preloadMetadataRegistries(): Promise<IdentityRegistry[]> {
    const res = this.db.exec(`SELECT authbase FROM bcmr;`);
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
    this.db.run(`DELETE FROM bcmr; DELETE FROM bcmr_tokens;`);
    await DatabaseService().saveDatabaseToFile();
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
    nftCommitment?: string
  ): Promise<string | null> {
    // pick the right URI map
    const snapshot = this.extractIdentity(authbase);
    const uris = nftCommitment
      ? snapshot.token?.nfts?.parse &&
        (snapshot.token.nfts as any).types[nftCommitment]?.uris
      : snapshot.uris;
    const iconUri = uris?.icon;
    if (!iconUri) return null;

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
      const dataUri = `data:;base64,${read.data}`;
      ICON_CACHE.set(filePath, dataUri);
      return dataUri;
    } catch {
      // not on disk yet
    }

    // 3) fetch from IPFS
    const resp = await ipfsFetch(iconUri);
    if (!resp.ok) {
      ICON_CACHE.set(filePath, null);
      return null;
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    const { binToBase64 } = await import('@bitauth/libauth');
    const b64 = binToBase64(buf);
    const dataUri = `data:;base64,${b64}`;

    // 4) write to filesystem cache for next time
    try {
      await Filesystem.writeFile({
        path: filePath,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
        data: b64,
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
    await DatabaseService().saveDatabaseToFile();
  }

  // A little helper that actually fetches & commits one registry:
  private async fetchAndCommitRegistry(
    authbase: string,
    uri: string
  ): Promise<IdentityRegistry> {
    const resp = await ipfsFetch(uri);
    // if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
    const data = await resp.json();
    const imported = importMetadataRegistry(data);
    if (typeof imported === 'string') throw new Error(imported);

    // on-chain fallback
    if (typeof (imported as any).registryIdentity === 'string') {
      const onChain = await this.resolveAuthChainRegistry(
        (imported as any).registryIdentity,
        uri
      );
      if (onChain) {
        this.inMemoryRegistries.set(authbase, onChain);
        return onChain;
      }
    }

    // commit to sqlite
    const committed = await this.commitIdentityRegistry(
      authbase,
      imported,
      uri
    );
    this.inMemoryRegistries.set(authbase, committed);
    return committed;
  }

  private async backgroundRefresh(
    authbase: string,
    uri: string
  ): Promise<void> {
    try {
      await this.fetchAndCommitRegistry(authbase, uri);
    } catch (err) {
      console.error('BCMR background refresh failed', err);
    }
  }
}
