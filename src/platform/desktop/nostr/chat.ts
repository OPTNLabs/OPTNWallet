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

import {
  SimplePool,
  finalizeEvent,
  getEventHash,
  nip19,
  type Event,
} from 'nostr-tools';
import { wrapManyEvents, unwrapEvent } from 'nostr-tools/nip17';
import { wrapManyEvents as wrapRumor } from 'nostr-tools/nip59';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import WalletManager from '../../../apis/WalletManager/WalletManager';
import { deriveNostrIdentity, type NostrIdentity } from './identity';

// Built-in bootstrap list — single source: defaultRelays.ts (also used by Redux).
export { DEFAULT_RELAYS, DISCOVERY_RELAYS, isDefaultNostrRelay } from './defaultRelays';
import { DEFAULT_RELAYS, DISCOVERY_RELAYS } from './defaultRelays';

const GIFT_WRAP = 1059;
const METADATA = 0;
const DM_RELAY_LIST = 10050; // NIP-17: where a user reads their private DMs
const REACTION = 7; // NIP-25
const DELETION = 5;
const KIND_30078 = 30078; // NIP-78 parameterized replaceable (Paytaca profile)
const PAYTACA_AVATAR = 'paytaca:avatar';
const PAYTACA_DISPLAY_NAME = 'paytaca:display-name';

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
  kind?: number; // 14 DM, 7 NIP-25, 5 delete
  replyTo?: string;
  editOf?: string;
  targetIds?: string[];
  emoji?: string;
  isReadReceipt?: boolean;
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

async function fetchKind10050(relays: string[], pubKey: string): Promise<string[]> {
  const lookup = Array.from(new Set([...DISCOVERY_RELAYS, ...relays]));
  try {
    const evt = await getPool().get(lookup, { kinds: [DM_RELAY_LIST], authors: [pubKey] });
    if (evt) {
      const urls = evt.tags.filter((t) => t[0] === 'relay' && t[1]).map((t) => t[1]);
      if (urls.length) return urls;
    }
  } catch {
    /* not found / unreachable — fall back to caller relays */
  }
  return [];
}

export function createKind10050(relays: string[], secretKey: Uint8Array): Event {
  return finalizeEvent(
    {
      kind: DM_RELAY_LIST,
      created_at: Math.floor(Date.now() / 1000),
      tags: relays.map((url) => ['relay', url]),
      content: '',
    },
    secretKey
  );
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
  const dmRelays = await fetchKind10050(relays, recipientHex);
  const targets = Array.from(new Set([...DISCOVERY_RELAYS, ...relays, ...dmRelays]));
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

export async function publishKind10050(
  walletId: number,
  relays: string[] = DEFAULT_RELAYS
): Promise<void> {
  const id = await getIdentity(walletId);
  const advertised = Array.from(new Set([...DISCOVERY_RELAYS, ...relays]));
  const evt = createKind10050(advertised, id.secretKey);
  await Promise.allSettled(getPool().publish(advertised, evt));
}

export const publishMyDmRelays = publishKind10050;

function rumorToChatMessage(
  rumor: {
    id: string;
    pubkey: string;
    content: string;
    created_at: number;
    kind?: number;
    tags: string[][];
  },
  mine: boolean
): ChatMessage {
  const kind = rumor.kind ?? 14;
  const to = rumor.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
  const targetIds = rumor.tags.filter((t) => t[0] === 'e' && t[1]).map((t) => t[1]);
  const replyTo = rumor.tags.find((t) => t[0] === 'e')?.[1];
  const editOf = rumor.tags.find((t) => t[0] === 'edit')?.[1];
  const isReadReceipt =
    kind === REACTION &&
    (rumor.content === '👀' ||
      rumor.tags.some((t) => t[0] === 'nonotif' && t[1] === 'read-receipt'));
  return {
    id: rumor.id,
    from: rumor.pubkey,
    to,
    text: rumor.content,
    at: rumor.created_at,
    mine,
    kind,
    replyTo,
    editOf,
    targetIds: targetIds.length ? targetIds : undefined,
    emoji: kind === REACTION ? rumor.content : undefined,
    isReadReceipt,
  };
}

export async function createReactionGiftWraps({
  messageId,
  senderPubKey,
  recipientPubKeys,
  emoji,
  reactorPubKey,
  reactorPrivKey,
  relayHint = '',
}: {
  messageId: string;
  senderPubKey: string;
  recipientPubKeys: string[];
  emoji: string;
  reactorPubKey: string;
  reactorPrivKey: Uint8Array;
  relayHint?: string;
}): Promise<Event[]> {
  const kind7 = {
    kind: REACTION,
    pubkey: reactorPubKey,
    created_at: Math.floor(Date.now() / 1000),
    content: emoji,
    tags: [
      ['e', messageId, relayHint, senderPubKey],
      ['p', senderPubKey, relayHint],
      ['k', '14'],
    ],
  };
  (kind7 as { id: string }).id = getEventHash(kind7);
  return wrapRumor(kind7, reactorPrivKey, recipientPubKeys) as Event[];
}

export async function createReadReceiptGiftWrap({
  messageIds,
  messageId,
  senderPubKey,
  receiverPubKey,
  receiverPrivKey,
  relayHint = '',
}: {
  messageIds?: string[];
  messageId?: string;
  senderPubKey: string;
  receiverPubKey: string;
  receiverPrivKey: Uint8Array;
  relayHint?: string;
}): Promise<Event> {
  const ids = messageIds ?? (messageId ? [messageId] : []);
  const kind7 = {
    kind: REACTION,
    pubkey: receiverPubKey,
    created_at: Math.floor(Date.now() / 1000),
    content: '👀',
    tags: [
      ...ids.map((id) => ['e', id, relayHint, senderPubKey]),
      ['p', senderPubKey, relayHint],
      ['k', '14'],
      ['nonotif', 'read-receipt'],
    ],
  };
  (kind7 as { id: string }).id = getEventHash(kind7);
  const wraps = wrapRumor(kind7, receiverPrivKey, [senderPubKey]) as Event[];
  return wraps[1] ?? wraps[0];
}

export async function createKind5DeletionGiftWraps({
  messageId,
  senderPubKey,
  members,
  senderPrivKey,
}: {
  messageId: string;
  senderPubKey: string;
  members: string[];
  senderPrivKey: Uint8Array;
}): Promise<Event[]> {
  const kind5 = {
    kind: DELETION,
    pubkey: senderPubKey,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['e', messageId],
      ['k', '14'],
    ],
  };
  (kind5 as { id: string }).id = getEventHash(kind5);
  return wrapRumor(kind5, senderPrivKey, members) as Event[];
}

export async function sendReaction(
  walletId: number,
  recipient: string,
  messageId: string,
  messageSenderPubKey: string,
  emoji: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<void> {
  const id = await getIdentity(walletId);
  const recipientHex = toPubkeyHex(recipient);
  const dmRelays = await fetchKind10050(relays, recipientHex);
  const targets = Array.from(new Set([...DISCOVERY_RELAYS, ...relays, ...dmRelays]));
  const wraps = await createReactionGiftWraps({
    messageId,
    senderPubKey: messageSenderPubKey,
    recipientPubKeys: [recipientHex],
    emoji,
    reactorPubKey: id.pubkey,
    reactorPrivKey: id.secretKey,
  });
  await Promise.allSettled(wraps.flatMap((w) => getPool().publish(targets, w)));
}

export async function sendReadReceipt(
  walletId: number,
  senderPubKey: string,
  messageIds: string[],
  relays: string[] = DEFAULT_RELAYS
): Promise<void> {
  if (!messageIds.length) return;
  const id = await getIdentity(walletId);
  const wrap = await createReadReceiptGiftWrap({
    messageIds,
    senderPubKey,
    receiverPubKey: id.pubkey,
    receiverPrivKey: id.secretKey,
  });
  const dmRelays = await fetchKind10050(relays, senderPubKey);
  const targets = Array.from(new Set([...DISCOVERY_RELAYS, ...relays, ...dmRelays]));
  await Promise.allSettled(getPool().publish(targets, wrap));
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
    sub = getPool().subscribeMany(Array.from(new Set([...DISCOVERY_RELAYS, ...relays])), { kinds: [GIFT_WRAP], '#p': [id.pubkey] }, {
      onevent(evt: Event) {
        try {
          const rumor = unwrapEvent(evt, id.secretKey);
          onMessage(rumorToChatMessage(rumor, rumor.pubkey === id.pubkey));
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

async function fetchKind30078(
  relays: string[],
  pubKey: string,
  dTag: string
): Promise<Event | null> {
  const lookup = Array.from(new Set([...DISCOVERY_RELAYS, ...relays]));
  try {
    return (
      (await getPool().get(lookup, {
        kinds: [KIND_30078],
        authors: [pubKey],
        '#d': [dTag],
      })) ?? null
    );
  } catch {
    return null;
  }
}

function parseKind30078Data(content: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(content || '{}') as {
      data?: Record<string, string>;
    };
    return parsed?.data ?? null;
  } catch {
    return null;
  }
}

export async function fetchPublishedAvatar(
  relays: string[],
  pubKey: string
): Promise<string | null> {
  const evt = await fetchKind30078(relays, pubKey, PAYTACA_AVATAR);
  const avatar = parseKind30078Data(evt?.content ?? '')?.avatar?.trim();
  return avatar || null;
}

export async function fetchPublishedDisplayName(
  relays: string[],
  pubKey: string
): Promise<string | null> {
  const evt = await fetchKind30078(relays, pubKey, PAYTACA_DISPLAY_NAME);
  const name = parseKind30078Data(evt?.content ?? '')?.displayName?.trim();
  return name || null;
}

export async function publishAvatar(
  walletId: number,
  avatarDataUrl: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<void> {
  const id = await getIdentity(walletId);
  const evt = finalizeEvent(
    {
      kind: KIND_30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', PAYTACA_AVATAR],
        ['p', id.pubkey],
      ],
      content: JSON.stringify({
        name: 'Paytaca Avatar',
        data: { avatar: avatarDataUrl },
      }),
    },
    id.secretKey
  );
  const targets = Array.from(new Set([...DISCOVERY_RELAYS, ...relays]));
  await Promise.allSettled(getPool().publish(targets, evt));
}

export async function publishDisplayName(
  walletId: number,
  displayName: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<void> {
  const id = await getIdentity(walletId);
  const evt = finalizeEvent(
    {
      kind: KIND_30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', PAYTACA_DISPLAY_NAME],
        ['p', id.pubkey],
      ],
      content: JSON.stringify({
        name: 'Paytaca Display Name',
        data: { displayName },
      }),
    },
    id.secretKey
  );
  const targets = Array.from(new Set([...DISCOVERY_RELAYS, ...relays]));
  await Promise.allSettled(getPool().publish(targets, evt));
}

const READ_STORE_KEY = (pubkey: string) => `nostr-chat-read:${pubkey}`;

export async function loadLastRead(
  pubkey: string
): Promise<Record<string, number>> {
  try {
    const stored = await idbGet(READ_STORE_KEY(pubkey));
    return stored && typeof stored === 'object'
      ? (stored as Record<string, number>)
      : {};
  } catch {
    return {};
  }
}

export async function storeLastRead(
  pubkey: string,
  lastRead: Record<string, number>
): Promise<void> {
  try {
    await idbSet(READ_STORE_KEY(pubkey), lastRead);
  } catch {
    /* best-effort */
  }
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
