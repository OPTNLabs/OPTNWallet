import {
  importMetadataRegistry,
  MetadataRegistry,
  IdentitySnapshot,
  RegistryTimestampKeyedValues,
} from '@bitauth/libauth';
import { ipfsFetch } from '../utils/ipfs';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { sha256 } from '../utils/hash';
import { DateTime } from 'luxon';

export interface IdentityRegistry {
  registry: MetadataRegistry;
  registryHash: string;
  registryUri: string;
  lastFetch: string;
}

export default class BcmrService {
  private db = DatabaseService().getDatabase();
  private CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  /**
   * Given a token category, return the associated authbase TXID (or fallback)
   */
  public async getCategoryAuthbase(category: string): Promise<string> {
    const result = this.db.exec(
      'SELECT authbase FROM bcmr_tokens WHERE category = ?',
      [category]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      return category;
    }
    const record = result[0];
    const authbase = record.values[0][record.columns.indexOf('authbase')];
    return authbase as string;
  }

  /** Default URI for fetching a registry */
  private getDefaultRegistryUri(authbase: string): string {
    return `https://bcmr.paytaca.com/api/registries/${authbase}/latest`;
  }

  /** Load registry from cache */
  private async loadIdentityRegistry(
    authbase: string
  ): Promise<IdentityRegistry> {
    const result = this.db.exec(
      `SELECT registryUri, lastFetch, registryHash, registryData FROM bcmr WHERE authbase = ?`,
      [authbase]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      throw new Error(`No BCMR cache for authbase ${authbase}`);
    }
    const record = result[0];
    const cols = record.columns;
    const row = record.values[0];
    const registryUri = row[cols.indexOf('registryUri')] as string;
    const lastFetch = row[cols.indexOf('lastFetch')] as string;
    const registryHash = row[cols.indexOf('registryHash')] as string;
    const registryData = row[cols.indexOf('registryData')] as string;

    const registry = importMetadataRegistry(registryData);
    if (typeof registry === 'string') throw new Error(registry);
    return { registry, registryHash, registryUri, lastFetch };
  }

  /** Persist registry to cache */
  private async commitIdentityRegistry(
    authbase: string,
    registry: MetadataRegistry,
    registryUri: string
  ): Promise<IdentityRegistry> {
    const json = JSON.stringify(registry);
    const registryHash = sha256.text(json);
    const lastFetch = new Date().toISOString();

    this.db.run(
      `INSERT INTO bcmr (authbase, registryUri, lastFetch, registryHash, registryData)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(authbase) DO UPDATE SET
           registryUri = excluded.registryUri,
           lastFetch   = excluded.lastFetch,
           registryHash= excluded.registryHash,
           registryData= excluded.registryData;`,
      [authbase, registryUri, lastFetch, registryHash, json]
    );

    await DatabaseService().saveDatabaseToFile();

    return { registry, registryHash, registryUri, lastFetch };
  }

  /** Extract current snapshot */
  public extractIdentity(
    authbase: string,
    registry: MetadataRegistry
  ): IdentitySnapshot {
    const history = (registry as any).identities?.[
      authbase
    ] as RegistryTimestampKeyedValues<IdentitySnapshot>;
    if (!history) {
      throw new Error(`No identity history for ${authbase}`);
    }
    const timestamps = Object.keys(history).sort().reverse();
    return history[timestamps[0]];
  }

  /** Resolve or refresh registry */
  public async resolveIdentityRegistry(
    categoryOrAuthbase: string
  ): Promise<IdentityRegistry> {
    const authbase = await this.getCategoryAuthbase(categoryOrAuthbase);
    let cache: IdentityRegistry | null = null;
    try {
      cache = await this.loadIdentityRegistry(authbase);
      const fetchedAt = DateTime.fromISO(cache.lastFetch);
      if (
        DateTime.now().toMillis() - fetchedAt.toMillis() <
        this.CACHE_TTL_MS
      ) {
        return cache;
      }
    } catch {
      // no valid cache
    }

    const registryUri =
      cache?.registryUri || this.getDefaultRegistryUri(authbase);
    const response = await ipfsFetch(registryUri);
    if (!response.ok) {
      throw new Error(
        `Failed fetching registry from ${registryUri}: ${response.status}`
      );
    }
    const data = await response.json();
    const imported = importMetadataRegistry(data);
    if (typeof imported === 'string') {
      throw new Error(imported);
    }

    return this.commitIdentityRegistry(authbase, imported, registryUri);
  }

  // TODO: chain resolution (resolveAuthChain, parseBcmrOutput, etc.)
}
