/**
 * Built-in bootstrap Nostr relays (chat + P2P fusion).
 * These are not user-removable in settings (same idea as Fulcrum seed servers).
 * Only relays the user adds themselves get a Remove button.
 *
 * Protocol: Nostr (NIP-01) is **WebSocket only** — `wss://` (TLS) or rarely
 * `ws://`. There is no plain TCP Nostr relay API like Electrum; server CashFusion
 * TCP is a different protocol. We only allow `wss://` in fusion/chat.
 *
 * Multi-relay redundancy: publish/subscribe to this whole set; first OK wins.
 * FusionP2pService MAX_RELAYS must be ≥ this list length (currently 30).
 *
 * Curated free generals only. Source candidates include community lists
 * (e.g. sesseor/nostr-relays-list); dead/paid/private IPs/NSFW junk excluded.
 * Alive filter: NIP-11 HTTPS probe 2026-08-06 (not a full WSS publish test).
 * Skip: nostr.wine / nostr.land fleets, relay.nostr.band (WSS hang history).
 */
export const DEFAULT_RELAYS: string[] = [
  // Core free generals
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://nostr.oxtr.dev',
  'wss://nostr.bitcoiner.social',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.net',
  'wss://relay.nostr.info',
  'wss://nostr.mom',
  'wss://purplerelay.com',
  // Alive free diversity (NIP-11 OK this probe)
  'wss://relay.orangepill.dev',
  'wss://nostr.einundzwanzig.space',
  'wss://nostr.rocks',
  'wss://relay.shawnyeager.com',
  'wss://nostr.vulpem.com',
  'wss://nostr.l00p.org',
  'wss://relay.nostr.wirednet.jp',
  'wss://relay.nostrview.com',
  'wss://relay.nostromo.social',
  'wss://relay.nostraddress.com',
  'wss://nostr.chaima.info',
  'wss://nostr.thank.eu',
  'wss://nostr.frostr.xyz',
  'wss://relay.fountain.fm',
  'wss://nostr.data.haus',
  'wss://relay.noswhere.com',
  // Replacements for dead prior entries (alive this probe)
  'wss://yabu.me',
  'wss://pyramid.fiatjaf.com',
];

const DEFAULT_SET = new Set(
  DEFAULT_RELAYS.map((r) => r.trim().toLowerCase())
);

/** True when this URL is a built-in bootstrap relay (not user-added). */
export function isDefaultNostrRelay(url: string): boolean {
  return DEFAULT_SET.has(url.trim().toLowerCase());
}

/** Merge bootstrap set with user list; bootstrap first, then user extras. */
export function mergeWithDefaultRelays(relays: string[] | undefined | null): string[] {
  const user = (relays ?? [])
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [...DEFAULT_RELAYS, ...user]) {
    const key = r.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
