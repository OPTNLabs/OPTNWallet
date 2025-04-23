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
import {
  queryAuthHead,
  queryTransactionByHash,
} from '../apis/ChaingraphManager/ChaingraphManager';
import bcmrLocalJson from '../assets/bcmr-optn-local.json';
import { ipfsFetch } from '../utils/ipfs';
import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { sha256 } from '../utils/hash';
import { DateTime } from 'luxon';

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
class BcmrRefreshError extends Error {
  constructor(public uri: string) {
    super(`Invalidate cache for ${uri}`);
  }
}

export interface IdentityRegistry {
  registry: MetadataRegistry;
  registryHash: string;
  registryUri: string;
  lastFetch: string;
}

export default class BcmrService {
  private db = DatabaseService().getDatabase();
  private CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

  public async getCategoryAuthbase(category: string): Promise<string> {
    const res = this.db.exec(
      'SELECT authbase FROM bcmr_tokens WHERE category = ?',
      [category]
    );
    if (res.length === 0 || res[0].values.length === 0) return category;
    const cols = res[0].columns;
    return res[0].values[0][cols.indexOf('authbase')] as string;
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
    await DatabaseService().saveDatabaseToFile();
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
   * 1) Try cache (7d TTL)
   * 2) Fetch off-chain JSON
   * 3) If JSON.registryIdentity is a string → on-chain fallback
   * 4) Commit & return
   */
  public async resolveIdentityRegistry(
    categoryOrAuthbase: string
  ): Promise<IdentityRegistry> {
    const authbase = await this.getCategoryAuthbase(categoryOrAuthbase);

    // try cache
    try {
      const cached = await this.loadIdentityRegistry(authbase);
      const age =
        DateTime.now().toMillis() -
        DateTime.fromISO(cached.lastFetch).toMillis();
      if (age < this.CACHE_TTL_MS) return cached;
      // stale ⇒ force refresh
      throw new BcmrRefreshError(cached.registryUri);
    } catch (e) {
      if (
        !(e instanceof BcmrRefreshError) &&
        !(e instanceof Error && e.message.startsWith('No BCMR'))
      ) {
        throw e;
      }
      // fall through to fetch fresh
    }

    // determine URI (preserve old one if present)
    const existing = await this.loadIdentityRegistry(authbase).catch(
      () => undefined
    );
    const registryUri =
      existing?.registryUri || this.getDefaultRegistryUri(authbase);

    // fetch off-chain JSON
    const resp = await ipfsFetch(registryUri);
    if (!resp.ok)
      throw new Error(
        `Failed fetching registry from ${registryUri}: ${resp.status}`
      );
    const data = await resp.json();
    const imported = importMetadataRegistry(data);
    if (typeof imported === 'string') throw new Error(imported);

    // on-chain fallback?
    if (typeof (imported as any).registryIdentity === 'string') {
      const onChain = await this.resolveAuthChainRegistry(
        (imported as any).registryIdentity,
        registryUri
      );
      if (onChain) return onChain;
    }

    return this.commitIdentityRegistry(authbase, imported, registryUri);
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

  // …the rest of your class (preload, purge, exportLocalBcmr, resolveIcon) …
}
