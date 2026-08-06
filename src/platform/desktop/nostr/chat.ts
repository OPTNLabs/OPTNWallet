// Nostr chat over NIP-17 (private DMs) — Phase 3.
//
// Direct messages are NIP-17: the message (kind 14) is sealed (NIP-59) and
// gift-wrapped (kind 1059) with per-message ephemeral keys and NIP-44 encryption,
// so relays and observers see only opaque wraps addressed to a pubkey — not the
// sender, content, or even that it's a DM. wrapManyEvents also produces a
// self-addressed copy so the sender sees their own sent messages.
//
// Relays are plain WSS, which the Tauri WebView opens directly — no Rust. The
// wallet's NIP-06 identity (identity.ts) signs/decrypts. The secret key is
// derived once per wallet and cached in memory only.

import { SimplePool, finalizeEvent, nip19, type Event } from 'nostr-tools';
import { wrapManyEvents, unwrapEvent } from 'nostr-tools/nip17';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import WalletManager from '../../../apis/WalletManager/WalletManager';
import { deriveNostrIdentity, type NostrIdentity } from './identity';

// Built-in bootstrap list — single source: defaultRelays.ts (also used by Redux).
export { DEFAULT_RELAYS, isDefaultNostrRelay } from './defaultRelays';
import { DEFAULT_RELAYS } from './defaultRelays';

const GIFT_WRAP = 1059;
const METADATA = 0;
const DM_RELAY_LIST = 10050; // NIP-17: where a user reads their private DMs

let pool: SimplePool | null = null;
const getPool = () => (pool ??= new SimplePool());

// Derived once per wallet (needs the decrypted mnemonic), cached in memory.
const identityCache = new Map<number, NostrIdentity>();
async function getIdentity(walletId: number): Promise<NostrIdentity> {
  const cached = identityCache.get(walletId);
  if (cached) return cached;
  const info = await WalletManager().getWalletInfo(walletId);
  const mnemonic = typeof info?.mnemonic === 'string' ? info.mnemonic : '';
  if (!mnemonic) throw new Error('Wallet mnemonic unavailable — unlock the wallet first.');
  const passphrase = typeof info?.passphrase === 'string' ? info.passphrase : '';
  const id = await deriveNostrIdentity(mnemonic, passphrase);
  identityCache.set(walletId, id);
  return id;
}

export interface ChatMessage {
  id: string;
  from: string; // sender pubkey hex
  to: string[]; // recipient pubkeys (the kind-14 'p' tags) — for threading
  text: string;
  at: number; // unix seconds
  mine: boolean;
}

export interface NostrProfile {
  pubkey: string;
  name?: string;
  picture?: string;
  about?: string;
  nip05?: string;
}

/** Accept an npub or a raw hex pubkey; return hex. */
export function toPubkeyHex(npubOrHex: string): string {
  const s = npubOrHex.trim();
  if (s.startsWith('npub')) {
    const decoded = nip19.decode(s);
    if (decoded.type !== 'npub') throw new Error('not an npub');
    return decoded.data;
  }
  if (!/^[0-9a-f]{64}$/i.test(s)) throw new Error('invalid pubkey');
  return s.toLowerCase();
}

export async function myIdentity(walletId: number): Promise<{ pubkey: string; npub: string }> {
  const id = await getIdentity(walletId);
  return { pubkey: id.pubkey, npub: id.npub };
}

/**
 * The recipient's NIP-17 DM relays (kind 10050) — where they actually read DMs.
 * Publishing a gift-wrap only to our own relays is the usual reason a DM never
 * arrives: the recipient isn't listening there. Falls back to empty (caller unions
 * with its own relays).
 */
async function recipientDmRelays(pubkeyHex: string, lookupRelays: string[]): Promise<string[]> {
  try {
    const evt = await getPool().get(lookupRelays, { kinds: [DM_RELAY_LIST], authors: [pubkeyHex] });
    if (evt) {
      const urls = evt.tags.filter((t) => t[0] === 'relay' && t[1]).map((t) => t[1]);
      if (urls.length) return urls;
    }
  } catch {
    /* not found / unreachable — fall back to caller relays */
  }
  return [];
}

/** Send a NIP-17 DM to `recipient` (npub or hex). Publishes to our relays AND the
 *  recipient's own DM relays (kind 10050) so it actually reaches them. */
export async function sendDirectMessage(
  walletId: number,
  recipient: string,
  text: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<void> {
  const id = await getIdentity(walletId);
  const recipientHex = toPubkeyHex(recipient);
  const dmRelays = await recipientDmRelays(recipientHex, relays);
  const targets = Array.from(new Set([...relays, ...dmRelays]));
  // wrapManyEvents prepends a self-addressed copy, so the sender's own messages
  // show up on their relays too.
  const wraps = wrapManyEvents(id.secretKey, [{ publicKey: recipientHex }], text);
  const results = await Promise.allSettled(wraps.flatMap((w) => getPool().publish(targets, w as Event)));
  // Surface total failure (offline / all relays refused) instead of silently
  // "sending" nothing — the usual cause of a message that never appears.
  if (results.length > 0 && !results.some((r) => r.status === 'fulfilled')) {
    const reason = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    throw new Error(
      `No relay accepted the message${reason ? `: ${String(reason.reason)}` : ''}. Check your connection or relays.`
    );
  }
}

/** Advertise where WE read DMs (kind 10050), so peers' sends reach us. */
export async function publishMyDmRelays(
  walletId: number,
  relays: string[] = DEFAULT_RELAYS
): Promise<void> {
  const id = await getIdentity(walletId);
  const evt = finalizeEvent(
    {
      kind: DM_RELAY_LIST,
      created_at: Math.floor(Date.now() / 1000),
      tags: relays.map((url) => ['relay', url]),
      content: '',
    },
    id.secretKey
  );
  await Promise.allSettled(getPool().publish(relays, evt));
}

/** Subscribe to incoming DMs for this wallet. Returns an unsubscribe fn. */
export function subscribeMessages(
  walletId: number,
  onMessage: (m: ChatMessage) => void,
  relays: string[] = DEFAULT_RELAYS
): () => void {
  let closed = false;
  let sub: { close: () => void } | null = null;
  void (async () => {
    const id = await getIdentity(walletId);
    if (closed) return;
    sub = getPool().subscribeMany(relays, { kinds: [GIFT_WRAP], '#p': [id.pubkey] }, {
      onevent(evt: Event) {
        try {
          const rumor = unwrapEvent(evt, id.secretKey);
          onMessage({
            id: rumor.id,
            from: rumor.pubkey,
            to: rumor.tags.filter((t) => t[0] === 'p').map((t) => t[1]),
            text: rumor.content,
            at: rumor.created_at,
            mine: rumor.pubkey === id.pubkey,
          });
        } catch {
          /* not addressed to us, or undecryptable — ignore */
        }
      },
    });
  })();
  return () => {
    closed = true;
    sub?.close();
  };
}

/** Fetch a pubkey's kind-0 profile metadata (name, picture, …). */
export async function fetchProfile(
  pubkeyOrNpub: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<NostrProfile> {
  const pubkey = toPubkeyHex(pubkeyOrNpub);
  const evt = await getPool().get(relays, { kinds: [METADATA], authors: [pubkey] });
  if (!evt) return { pubkey };
  try {
    const c = JSON.parse(evt.content) as Record<string, string>;
    return { pubkey, name: c.name ?? c.display_name, picture: c.picture, about: c.about, nip05: c.nip05 };
  } catch {
    return { pubkey };
  }
}

/** Publish this wallet's own kind-0 profile (name + picture). */
export async function publishMyProfile(
  walletId: number,
  profile: { name?: string; picture?: string; about?: string },
  relays: string[] = DEFAULT_RELAYS
): Promise<void> {
  const id = await getIdentity(walletId);
  const evt = finalizeEvent(
    {
      kind: METADATA,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(profile),
    },
    id.secretKey
  );
  await Promise.allSettled(getPool().publish(relays, evt));
}

// --- Local persistence (chat history saved in the wallet, Paytaca-style) ---
// Keyed by the wallet's Nostr pubkey in the shared idb-keyval store (same store as
// the wallet DB), so each wallet's conversations + contacts survive restarts and
// are shown instantly, rather than reconstructed from relays every session.
const CHAT_STORE_KEY = (pubkey: string) => `nostr-chat:${pubkey}`;

/**
 * Check which relays are reachable right now by opening a WebSocket to each.
 * Returns a url→online map for the settings UI.
 *
 * This only probes reachability — it cannot force a third-party relay to stay
 * up. Fusion already treats the pool as multi-relay (first OK wins); a few red
 * dots are normal and do not block a round by themselves.
 *
 * @param timeoutMs per-relay open budget (Tor needs more than LAN; default 8s)
 * @param onProgress optional per-URL update as each socket finishes
 */
export function checkRelayStatus(
  relays: string[],
  timeoutMs = 8_000,
  onProgress?: (url: string, online: boolean) => void
): Promise<Record<string, boolean>> {
  return Promise.all(
    relays.map(
      (url) =>
        new Promise<[string, boolean]>((resolve) => {
          let done = false;
          let ws: WebSocket | null = null;
          const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            try {
              ws?.close();
            } catch {
              /* ignore */
            }
            onProgress?.(url, ok);
            resolve([url, ok]);
          };
          try {
            ws = new WebSocket(url);
          } catch {
            onProgress?.(url, false);
            resolve([url, false]);
            return;
          }
          ws.onopen = () => finish(true);
          ws.onerror = () => finish(false);
          setTimeout(() => finish(false), timeoutMs);
        })
    )
  ).then((entries) => Object.fromEntries(entries));
}

/** Load this identity's saved messages (contacts derive from them). */
export async function loadStoredMessages(pubkey: string): Promise<ChatMessage[]> {
  try {
    const stored = await idbGet(CHAT_STORE_KEY(pubkey));
    return Array.isArray(stored) ? (stored as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

/** Persist this identity's messages (best-effort). */
export async function storeMessages(pubkey: string, messages: ChatMessage[]): Promise<void> {
  try {
    await idbSet(CHAT_STORE_KEY(pubkey), messages);
  } catch {
    /* best-effort — a storage failure shouldn't break chat */
  }
}
