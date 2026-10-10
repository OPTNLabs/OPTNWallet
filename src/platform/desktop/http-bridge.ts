// Desktop fetch bridge.
//
// The webview never reaches the network itself. Its CSP allows only the app's
// own origin, IPC and loopback, so every remote HTTP request made through
// `fetch` comes here and is performed by Rust (`optn_http_fetch`). Rust applies
// the holder's Tor switch: through verified Tor when Tor is on (or not at all),
// directly when it is off. It also allows only the hosts this app contacted
// before, so routing through Rust adds privacy, never new destinations.
//
// A side effect that once needed its own command: Rust sends no browser
// `Origin`, which the price server rejects. Upstream callers are unchanged;
// they get an ordinary `Response`.
//
// Loopback requests (the local Trezor Bridge) stay on the webview fetch, and so
// do the app's own hosts: Tauri's IPC is a fetch to `ipc.localhost` on Windows,
// and the bridge itself is an IPC call (see `bridgedToRust`).

import { invoke } from '@tauri-apps/api/core';
import { bridgedToRust, rendererNetwork } from './rendererNetwork';

const nativeFetch = window.fetch.bind(window);

/** Rust bounds a request at 60 s; this keeps a caller's own timeout honest. */
const NATIVE_FETCH_TIMEOUT_MS = 65_000;

type NativeResponse = {
  status: number;
  headers: [string, string][];
  bodyBase64: string;
  url: string;
};

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request)
    return input.url;
  return String(input);
}

function routedNatively(url: string): boolean {
  return bridgedToRust(url, window.location.href);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal | null
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TypeError('Network request timed out')),
      NATIVE_FETCH_TIMEOUT_MS
    );
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // fetch rejects with a TypeError on a network failure; keep that shape.
        reject(
          new TypeError(error instanceof Error ? error.message : String(error))
        );
      }
    );
  });
}

export async function nativeHttpFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const request = new Request(input, init);
  const signal = init?.signal ?? request.signal;
  // An aborted request never reaches the network, as with `fetch`.
  if (signal?.aborted) throw abortError();
  const method = request.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD'
      ? null
      : new Uint8Array(await request.arrayBuffer());
  if (signal?.aborted) throw abortError();
  const headers: [string, string][] = [];
  request.headers.forEach((value, name) => headers.push([name, value]));
  const response = await abortable(
    invoke<NativeResponse>('optn_http_fetch', {
      request: {
        method,
        url: request.url,
        headers,
        bodyBase64: body && body.length > 0 ? toBase64(body) : null,
      },
      network: rendererNetwork(),
    }),
    signal
  );
  const nullBody =
    method === 'HEAD' || [101, 204, 205, 304].includes(response.status);
  const result = new Response(
    nullBody ? null : (fromBase64(response.bodyBase64) as BodyInit),
    { status: response.status, headers: response.headers }
  );
  Object.defineProperty(result, 'url', { value: response.url });
  return result;
}

const patchedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = urlOf(input);
  if (routedNatively(url)) return nativeHttpFetch(input, init);
  return nativeFetch(input as RequestInfo, init);
}) as typeof window.fetch;
window.fetch = patchedFetch;
