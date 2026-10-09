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
