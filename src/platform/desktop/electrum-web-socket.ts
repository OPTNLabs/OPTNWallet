// Desktop replacement for @electrum-cash/web-socket, aliased in
// vite.desktop.config.ts. Same class name + ElectrumSocket interface, but backed
// by a native TCP(+TLS) connection in Rust instead of a browser WebSocket.
//
// Why: most Fulcrum servers only publish the raw Electrum TCP-SSL port (50002)
// and never expose a WebSocket (50004). A browser/WebView can only open
// WebSockets, so on the web build those servers are simply unreachable. On
// desktop we have a real socket (via the electrum_tcp_* Tauri commands), and
// TCP-SSL is actually the MORE universal Electrum transport — nearly every
// server exposes 50002, WSS is the add-on — so desktop routes through it.
//
// The Electrum client hands us newline-delimited JSON-RPC and consumes the same
// back; this class just moves those bytes to/from the Rust connection and
// re-emits the same 'connected' / 'disconnected' / 'data' / 'error' events the
// real ElectrumWebSocket does, so @electrum-cash/network can't tell the
// difference.

import { EventEmitter } from 'eventemitter3';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// Standard BCH Electrum ports. parseServerEntry in ElectrumServer.ts turns a
// bare host into the WSS port (50004); map those to the TCP equivalents since
// this transport is raw TCP, not WebSocket. An explicit TCP-SSL port (50002)
// passes through unchanged.
function toTcpPort(port: number): number {
  if (port === 50004) return 50002; // WSS(TLS) -> TCP(TLS)
  if (port === 50003) return 50001; // WS(plain) -> TCP(plain)
  return port;
}

export class ElectrumWebSocket extends EventEmitter {
  host: string;
  port: number;
  encrypted: boolean;
  timeout: number;

  private connId: number | null = null;
  private unlistenData: UnlistenFn | null = null;
  private unlistenClosed: UnlistenFn | null = null;

  constructor(host: string, port = 50002, encrypted = true, timeout = 5000) {
    super();
    this.host = host;
    this.port = toTcpPort(port);
    this.encrypted = encrypted;
    this.timeout = timeout;
  }

  get hostIdentifier(): string {
    return `${this.host}:${this.port}`;
  }

  connect(): void {
    void (async () => {
      try {
        const id = await invoke<number>('electrum_tcp_connect', {
          host: this.host,
          port: this.port,
          useSsl: this.encrypted,
        });
        this.connId = id;

        this.unlistenData = await listen<string>(`electrum-tcp://data/${id}`, (event) => {
          this.emit('data', event.payload);
        });
        this.unlistenClosed = await listen(`electrum-tcp://closed/${id}`, () => {
          this.cleanup();
          this.emit('disconnected');
        });

        this.emit('connected');
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  disconnect(): void {
    const id = this.connId;
    this.cleanup();
    if (id !== null) {
      void invoke('electrum_tcp_close', { id }).catch(() => {
        /* already gone */
      });
    }
    this.emit('disconnected');
  }

  write(data: Uint8Array | string, callback?: (err?: Error) => void): boolean {
    const id = this.connId;
    if (id === null) {
      const err = new Error('socket not connected');
      this.emit('error', err);
      callback?.(err);
      return false;
    }
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    void invoke('electrum_tcp_send', { id, data: text })
      .then(() => callback?.())
      .catch((err) => {
        const e = err instanceof Error ? err : new Error(String(err));
        this.emit('error', e);
        callback?.(e);
      });
    return true;
  }

  private cleanup(): void {
    this.connId = null;
    this.unlistenData?.();
    this.unlistenClosed?.();
    this.unlistenData = null;
    this.unlistenClosed = null;
  }
}
