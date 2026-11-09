// The network this window shows, for requests Rust makes on its behalf.
//
// Rust routes by the stricter of this and the shared runtime's network, so a
// window is never routed more loosely than its own network's Tor switch says.
// Set from redux by `useTransportConfig`; read by the fetch, socket, image and
// Electrum bridges, which load before the store exists.

const KEY = '__OPTN_RENDERER_NETWORK__';

export function setRendererNetwork(network: string): void {
  (globalThis as Record<string, unknown>)[KEY] = network;
}

export function rendererNetwork(): string | null {
  const value = (globalThis as Record<string, unknown>)[KEY];
  return typeof value === 'string' ? value : null;
}

/**
 * The app's own hosts. On Windows, Tauri serves the page, its IPC and its
 * asset protocol from `<scheme>.localhost` (`http://ipc.localhost/<command>`),
 * and RFC 6761 keeps every `.localhost` name on this machine. None of them is
 * the network.
 */
export function isAppHost(host: string): boolean {
  return host.toLowerCase().replace(/\.$/, '').endsWith('.localhost');
}

/**
 * Whether the fetch bridge hands `url` to Rust: remote http(s) only.
 *
 * Never the app's own hosts. Tauri's IPC is itself a `fetch` to
 * `ipc.localhost`, so bridging it would send each command back through IPC,
 * which is another fetch, wrapping the last request in the next without end:
 * the renderer grew past 7 GB and died before anything else ran.
 */
export function bridgedToRust(url: string, pageHref: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, pageHref);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.origin === new URL(pageHref).origin) return false;
  if (isAppHost(parsed.hostname)) return false;
  return !isLoopbackHost(parsed.hostname);
}

/** Exactly what Rust's `is_loopback_host` accepts. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h === '::1' ||
    /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(h)
  );
}
