import { isDesktopPlatform } from './platform';
import { isAppHost } from '../platform/desktop/rendererNetwork';

/**
 * A remote image named by a dApp, a peer, an add-on or an indexer, as something
 * the page may load.
 *
 * On desktop the webview may not reach the network: Rust fetches the bytes
 * under the holder's Tor switch and returns a bounded `data:` URL, or nothing.
 * Elsewhere the URL is used as it is. Local and inline sources pass through.
 */
const resolved = new Map<string, Promise<string | null>>();
const MAX_REMEMBERED = 256;

/** What the page may use without asking Rust, or undefined when it must ask. */
export function localImageSrc(
  url: string | null | undefined
): string | null | undefined {
  if (!url) return null;
  // Protocol-relative first: `//host/x` also starts with `/`.
  if (url.startsWith('//')) return isDesktopPlatform() ? undefined : url;
  if (
    /^(data:|blob:)/i.test(url) ||
    url.startsWith('/') ||
    url.startsWith('.')
  ) {
    return url;
  }
  if (!isDesktopPlatform()) return url;
  // The app's own asset protocol (`http://asset.localhost/...` on Windows)
  // never leaves the machine and is not Rust's to fetch.
  try {
    const parsed = new URL(url);
    if (/^https?:$/.test(parsed.protocol) && isAppHost(parsed.hostname)) {
      return url;
    }
  } catch {
    /* not an absolute URL; asked of Rust as before */
  }
  return undefined;
}

export function remoteImageSrc(
  url: string | null | undefined
): Promise<string | null> {
  const local = localImageSrc(url);
  if (local !== undefined || !url) return Promise.resolve(local ?? null);
  const absolute = url.startsWith('//') ? `https:${url}` : url;
  if (!/^https:\/\//i.test(absolute)) return Promise.resolve(null);
  const known = resolved.get(absolute);
  if (known) return known;
  const pending = Promise.all([
    import('@tauri-apps/api/core'),
    import('../platform/desktop/rendererNetwork'),
  ])
    .then(([{ invoke }, { rendererNetwork }]) =>
      invoke<string | null>('optn_remote_image', {
        url: absolute,
        network: rendererNetwork(),
      })
    )
    .catch(() => null)
    .then((value) => {
      // Only an image is remembered. Nothing, or a failure (Tor still
      // starting, a timeout), is asked again next time.
      if (value == null && resolved.get(absolute) === pending) {
        resolved.delete(absolute);
      }
      return value;
    });
  if (resolved.size >= MAX_REMEMBERED) {
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) resolved.delete(oldest);
  }
  resolved.set(absolute, pending);
  return pending;
}
