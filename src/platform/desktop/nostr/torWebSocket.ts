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

let armedSocks: { host: string; port: number } | null = null;

/** Route Nostr relay traffic through this Tor SOCKS proxy until disarmed. */
export function armTorRouting(socks: { host: string; port: number }): void {
  armedSocks = socks;
}
export function disarmTorRouting(): void {
  armedSocks = null;
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

  constructor(url: string) {
    // Not in a fusion round → behave exactly like a normal WebSocket (chat, etc.).
    if (!armedSocks) {
      return new NativeWebSocket(url) as unknown as TorWebSocket;
    }
    this.url = url;
    const socks = armedSocks;
    void this.open(url, socks);
  }

  private async open(url: string, socks: { host: string; port: number }): Promise<void> {
    try {
      const id = await invoke<number>('nostr_tor_open', {
        url,
        socksHost: socks.host,
        socksPort: socks.port,
      });
      this.id = id;
      // Subscribe before signalling open so no relay response is missed.
      this.unlisteners.push(
        await listen<string>(`nostr-tor://msg/${id}`, (e) => this.onmessage?.({ data: e.payload })),
        await listen(`nostr-tor://closed/${id}`, () => {
          this.readyState = TorWebSocket.CLOSED;
          this.onclose?.({});
          this.cleanup();
        })
      );
      this.readyState = TorWebSocket.OPEN;
      this.onopen?.({});
    } catch (err) {
      this.readyState = TorWebSocket.CLOSED;
      this.onerror?.({ message: err instanceof Error ? err.message : String(err) });
      this.onclose?.({});
    }
  }

  send(data: string): void {
    if (this.id != null) void invoke('nostr_tor_send', { id: this.id, data });
  }

  close(): void {
    this.readyState = TorWebSocket.CLOSING;
    if (this.id != null) void invoke('nostr_tor_close', { id: this.id });
    this.cleanup();
  }

  private cleanup(): void {
    for (const un of this.unlisteners) un();
    this.unlisteners = [];
  }
}
