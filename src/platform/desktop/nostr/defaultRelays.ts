/**
 * Built-in bootstrap Nostr relays (chat + P2P fusion).
 * These are not user-removable in settings (same idea as Fulcrum seed servers).
 * Only relays the user adds themselves get a Remove button.
 *
 * Protocol: Nostr (NIP-01) is **WebSocket only** — `wss://` (TLS) or rarely
 * `ws://`. There is no plain TCP Nostr relay API like Electrum; server CashFusion
 * TCP is a different protocol. We only allow `wss://` in fusion/chat.
 *
 * Bootstrap list for settings / merge. Fusion pool discovery uses only the
 * first ~8 (shared prefix) so multi-wallet Tor does not partition; gift-wrap
 * rounds use the same prefix. Chat may still probe the full list.
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

/** Normalize for comparison (case, trailing slash). */
export function normalizeRelayUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Former bootstrap / known-dead hosts. Dropped from the built-in list and
 * stripped from persisted user extras so they stop showing as removable reds.
 */
export const RETIRED_RELAYS: readonly string[] = [
  'wss://nostrue.com',
  'wss://relay.0xchat.com',
];

const RETIRED_SET = () =>
  new Set(RETIRED_RELAYS.map((r) => normalizeRelayUrl(r)));

/** True when this URL is a built-in bootstrap relay (not user-added). */
export function isDefaultNostrRelay(url: string): boolean {
  const key = normalizeRelayUrl(url);
  // Read DEFAULT_RELAYS live so HMR / list edits never leave a stale Set.
  return DEFAULT_RELAYS.some((r) => normalizeRelayUrl(r) === key);
}

/**
 * Merge bootstrap set with user list; bootstrap first (canonical URLs), then
 * user extras that are not defaults. Retired dead hosts are stripped so they
 * do not linger as removable reds after we drop them from DEFAULT_RELAYS.
 */
export function mergeWithDefaultRelays(relays: string[] | undefined | null): string[] {
  const retired = RETIRED_SET();
  const user = (relays ?? [])
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .filter((r) => !retired.has(normalizeRelayUrl(r)));
  const seen = new Set<string>();
  const out: string[] = [];
  // Always emit canonical DEFAULT_RELAYS strings first (stable, non-removable).
  for (const r of DEFAULT_RELAYS) {
    const key = normalizeRelayUrl(r);
    if (seen.has(key) || retired.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  for (const r of user) {
    const key = normalizeRelayUrl(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
