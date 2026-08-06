/**
 * Built-in bootstrap Nostr relays (chat + P2P fusion).
 * These are not user-removable in settings (same idea as Fulcrum seed servers).
 * Only relays the user adds themselves get a Remove button.
 *
 * Keep in sync with selection notes in chat.ts / experimentalSlice.
 */
export const DEFAULT_RELAYS: string[] = [
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
