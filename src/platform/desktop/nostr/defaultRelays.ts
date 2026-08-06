/**
 * Built-in bootstrap Nostr relays (chat + P2P fusion).
 * These are not user-removable in settings (same idea as Fulcrum seed servers).
 * Only relays the user adds themselves get a Remove button.
 *
 * Multi-relay redundancy: fusion publishes/subscribes to this whole set;
 * first OK wins (publishEventAtLeastOnce). FusionP2pService caps at MAX_RELAYS
 * (30) so this list must stay ≤ that.
 *
 * Free general-purpose only. Skip paid (nostr.wine, nostr.land, …) and
 * relay.nostr.band (historical WSS hang). Re-probe via NIP-11 when expanding.
 */
export const DEFAULT_RELAYS: string[] = [
  // Core bootstrap (widely used free generals)
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  // Long-running free community / developer relays
  'wss://nostr.oxtr.dev',
  'wss://nostr.bitcoiner.social',
  'wss://nostr-pub.wellorder.net',
  'wss://relay.nostr.net',
  'wss://relay.nostr.info',
  'wss://nostr.mom',
  'wss://purplerelay.com',
  // Free diversity (prior probe)
  'wss://relay.orangepill.dev',
  'wss://nostr.einundzwanzig.space',
  'wss://nostr.rocks',
  'wss://relay.shawnyeager.com',
  'wss://nostr.vulpem.com',
  'wss://nostr.l00p.org',
  // Expanded free set (NIP-11 OK 2026-08-06 second probe) — toward cap 30
  'wss://relay.nostr.wirednet.jp',
  'wss://relay.nostrview.com',
  'wss://relay.nostromo.social',
  'wss://relay.nostraddress.com',
  'wss://nostr.chaima.info',
  'wss://nostr.thank.eu',
  'wss://nostr.frostr.xyz',
  'wss://relay.fountain.fm',
  'wss://nostr.data.haus',
  'wss://nostrue.com',
  'wss://relay.noswhere.com',
  'wss://relay.0xchat.com',
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
