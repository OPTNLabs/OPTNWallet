// A WebSocket shim that routes Nostr relay traffic through Tor for P2P CashFusion.
//
// nostr-tools' useWebSocketImplementation replaces the WebSocket class process-
// wide, so chat uses it too. To avoid forcing chat onto Tor, this shim only routes
// through the Rust Tor->WSS bridge (nostr_tor.rs) when routing is "armed" — which
// runP2pFusion does only for the duration of a fusion round. When not armed, the
// constructor returns a genuine native WebSocket, so chat is completely unaffected.
//
// Armed connections open via `nostr_tor_open` (Tor+TLS+WS handshake in Rust) and
// exchange text frames over Tauri events, presenting the small slice of the
// WebSocket interface nostr-tools actually uses (onopen/onmessage/onclose/onerror,
// send, close, readyState).

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

const NativeWebSocket = globalThis.WebSocket;

/** A Tor circuit + TLS + WS handshake is slow but not unbounded; past this the
 *  circuit is wedged and retrying beats waiting. */
const TOR_OPEN_TIMEOUT_MS = 45_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onLateResolve?: (value: T) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      reject(new Error(message));
    }, ms);
    promise.then(
      (value) => {
        if (finished) {
          onLateResolve?.(value);
          return;
        }
        finished = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

let armedSocks: { host: string; port: number } | null = null;
let armedHolders = 0;

/**
 * Route Nostr relay traffic through this Tor SOCKS proxy until this holder
 * releases its token.
 *
 * A reference-counted token prevents one overlapping round from clearing the
 * route while another still owns it. Different proxy settings cannot share one
 * WebView-global WebSocket implementation, so that conflict fails closed.
 */
export function armTorRouting(socks: {
  host: string;
  port: number;
}): () => void {
  if (
    armedSocks &&
    (armedSocks.host !== socks.host || armedSocks.port !== socks.port)
  ) {
    throw new Error('A different Tor route is already active.');
  }
  armedSocks = socks;
  armedHolders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    armedHolders = Math.max(0, armedHolders - 1);
    if (armedHolders === 0) armedSocks = null;
  };
}

type Handler = ((ev: unknown) => void) | null;

export class TorWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState = TorWebSocket.CONNECTING;
  onopen: Handler = null;
  onmessage: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;

  private id: number | null = null;
  private unlisteners: UnlistenFn[] = [];
  private closeRequested = false;

  constructor(url: string) {
    // Not in a fusion round → behave exactly like a normal WebSocket (chat, etc.).
    if (!armedSocks) {
      return new NativeWebSocket(url) as unknown as TorWebSocket;
    }
    this.url = url;
    const socks = armedSocks;
    void this.open(url, socks);
  }

  private async open(
    url: string,
    socks: { host: string; port: number }
  ): Promise<void> {
    try {
      // `nostr_tor_open` builds a Tor circuit, then TLS, then the WS handshake.
      // Any of those can stall indefinitely on a wedged circuit, and nothing
      // downstream imposes a deadline: neither onopen nor onerror would ever
      // fire, so nostr-tools' publish/subscribe promises never settle and a
      // fusion round hangs forever at "preparing fresh pool identity" with no
      // way out. Fail the socket instead so the caller sees a real error.
      const id = await withTimeout(
        invoke<number>('nostr_tor_open', {
          url,
          socksHost: socks.host,
          socksPort: socks.port,
        }),
        TOR_OPEN_TIMEOUT_MS,
        `Tor connection to ${url} timed out`,
        (lateId) => {
          void invoke('nostr_tor_close', { id: lateId });
        }
      );
      if (this.closeRequested) {
        await invoke('nostr_tor_close', { id }).catch(() => undefined);
        this.readyState = TorWebSocket.CLOSED;
        return;
      }
      this.id = id;
      // Subscribe before signalling open so no relay response is missed.
      const messageUnlisten = await listen<string>(
        `nostr-tor://msg/${id}`,
        (e) => this.onmessage?.({ data: e.payload })
      );
      const closedUnlisten = await listen(`nostr-tor://closed/${id}`, () => {
        this.id = null;
        this.readyState = TorWebSocket.CLOSED;
        this.onclose?.({});
        this.cleanup();
      });
      if (this.closeRequested) {
        messageUnlisten();
        closedUnlisten();
        await invoke('nostr_tor_close', { id }).catch(() => undefined);
        this.id = null;
        this.readyState = TorWebSocket.CLOSED;
        return;
      }
      this.unlisteners.push(messageUnlisten, closedUnlisten);
      this.readyState = TorWebSocket.OPEN;
      this.onopen?.({});
    } catch (err) {
      this.readyState = TorWebSocket.CLOSED;
      if (this.closeRequested) {
        this.cleanup();
        return;
      }
      this.onerror?.({
        message: err instanceof Error ? err.message : String(err),
      });
      this.onclose?.({});
    }
  }

  send(data: string): void {
    if (this.id != null) void invoke('nostr_tor_send', { id: this.id, data });
  }

  close(): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.readyState = TorWebSocket.CLOSING;
    if (this.id != null) {
      const id = this.id;
      this.id = null;
      void invoke('nostr_tor_close', { id });
    }
    this.cleanup();
    this.readyState = TorWebSocket.CLOSED;
  }

  private cleanup(): void {
    for (const un of this.unlisteners) un();
    this.unlisteners = [];
  }
}
