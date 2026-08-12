// Desktop fetch bridge.
//
// The OPTN price server returns HTTP 500 for any browser `Origin` header, and the
// Tauri webview's fetch (and @tauri-apps/plugin-http) always send the webview
// origin, which can't be stripped from JS. The mobile app avoids this via
// Capacitor native HTTP (no browser Origin). Here we do the desktop equivalent:
// requests to the trusted price host are performed by a Rust command
// (`optn_price_fetch`, reqwest, no Origin), and the result is wrapped back into a
// standard Response so the upstream code (which calls `fetch().json()`) is unchanged.
//
// SECURITY: only the explicit price host is routed to the native command (which is
// itself hardcoded to that host). Loopback / private / link-local are refused.
// Every other request stays on the native, CORS-enforced webview fetch. Upstream
// source is untouched.

import { invoke } from '@tauri-apps/api/core';

const NATIVE_HOSTS = new Set<string>(['price.optnlabs.com']);

const nativeFetch = window.fetch.bind(window);

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (h === '0.0.0.0') return true;
  return false;
}

function shouldUseNative(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  if (isPrivateHost(host)) return false;
  return NATIVE_HOSTS.has(host);
}

async function nativeHttpGet(url: string): Promise<Response> {
  const body = await invoke<string>('optn_price_fetch', { url });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const patchedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = urlOf(input);
  if (/^https?:\/\//i.test(url) && shouldUseNative(url)) {
    // Trusted price host → Rust reqwest (no browser Origin), wrapped as a Response.
    return nativeHttpGet(url);
  }
  // Everything else → native, CORS-enforced webview fetch.
  return nativeFetch(input as RequestInfo, init);
}) as typeof window.fetch;
window.fetch = patchedFetch;
