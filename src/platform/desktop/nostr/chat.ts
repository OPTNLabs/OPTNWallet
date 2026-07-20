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
import WalletManager from '../../../apis/WalletManager/WalletManager';
import { deriveNostrIdentity, type NostrIdentity } from './identity';

/** Sensible public relays as a starting set; users can add their own. */
export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
];

const GIFT_WRAP = 1059;
const METADATA = 0;

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

/** Send a NIP-17 DM to `recipient` (npub or hex). Publishes to all relays. */
export async function sendDirectMessage(
  walletId: number,
  recipient: string,
  text: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<void> {
  const id = await getIdentity(walletId);
  const recipientHex = toPubkeyHex(recipient);
  // wrapManyEvents prepends a self-addressed copy, so the sender's own messages
  // show up on their relays too.
  const wraps = wrapManyEvents(id.secretKey, [{ publicKey: recipientHex }], text);
  await Promise.allSettled(wraps.flatMap((w) => getPool().publish(relays, w as Event)));
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
