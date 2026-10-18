// Desktop WebSocket bridge.
//
// The webview never opens a socket to the network itself: its CSP allows only
// the app's own origin, IPC and loopback. This replaces `WebSocket` before any
// library loads, so WalletConnect, CashConnect, WizardConnect and Nostr chat
// open their relays through Rust (`optn_ws_open`) under the holder's Tor
// switch: through verified Tor when Tor is on, or not at all; directly when it
// is off. P2P CashFusion still arms its own Tor-only socket on top of this.
//
// A plain `ws` URL to loopback (a local dev server) keeps the webview's socket.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isLoopbackHost, rendererNetwork } from './rendererNetwork';

const WebviewWebSocket = globalThis.WebSocket;

/** Rust gives up at 40 s; this only covers an IPC that never answers. */
const OPEN_TIMEOUT_MS = 45_000;

function webviewSocketAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'ws:' && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function eventKey(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(16).slice(2) + Date.now().toString(16);
  return `ws-${random}`.slice(0, 64);
}

type Listener = ((event: Event) => void) | null;

export class NativeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readonly protocol = '';
  readonly extensions = '';
  readyState = NativeWebSocket.CONNECTING;
  bufferedAmount = 0;
  binaryType: BinaryType = 'blob';
  onopen: Listener = null;
  onmessage: Listener = null;
  onclose: Listener = null;
  onerror: Listener = null;

  private id: number | null = null;
  private unlisteners: UnlistenFn[] = [];
  private closeRequested = false;
  private closed = false;
  /** Every send and the close go out in order, one IPC at a time. */
  private outbound: Promise<unknown> = Promise.resolve();

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    void this.open();
  }

  /** Deliver an event. A listener that throws is reported, never allowed to
   *  change the socket's state, as with a browser socket. */
  private emit(event: Event): void {
    const handler = (this as unknown as Record<string, Listener>)[
      `on${event.type}`
    ];
    try {
      handler?.call(this, event);
    } catch (error) {
      reportError(error);
    }
    try {
      this.dispatchEvent(event);
    } catch (error) {
      reportError(error);
    }
  }

  private finish(code: number, reason: string, wasClean: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = NativeWebSocket.CLOSED;
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
    this.emit(new CloseEvent('close', { code, reason, wasClean }));
  }

  private async open(): Promise<void> {
    const key = eventKey();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Listen before asking Rust to open, so a frame or a close that arrives
      // the moment the relay accepts is never missed.
      this.unlisteners.push(
        await listen<string>(`nostr-tor://msg/${key}`, (event) => {
          if (!this.closed)
            this.emit(new MessageEvent('message', { data: event.payload }));
        }),
        await listen(`nostr-tor://closed/${key}`, () => {
          this.id = null;
          this.finish(1006, '', false);
        })
      );
      const opening = invoke<number>('optn_ws_open', {
        url: this.url,
        network: rendererNetwork(),
        events: key,
      });
      const id = await new Promise<number>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Connection to ${this.url} timed out`));
          void opening.then(
            (late) => invoke('nostr_tor_close', { id: late }),
            () => undefined
          );
        }, OPEN_TIMEOUT_MS);
        opening.then(resolve, reject);
      });
      clearTimeout(timer);
      if (this.closed) {
        await invoke('nostr_tor_close', { id }).catch(() => undefined);
        return;
      }
      if (this.closeRequested) {
        await invoke('nostr_tor_close', { id }).catch(() => undefined);
        this.finish(1000, '', true);
        return;
      }
      this.id = id;
      this.readyState = NativeWebSocket.OPEN;
      this.emit(new Event('open'));
    } catch (error) {
      clearTimeout(timer);
      if (!this.closeRequested && !this.closed) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[socket-bridge] ${this.url}: ${message}`);
        this.emit(new Event('error'));
      }
      this.finish(1006, '', false);
    }
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== NativeWebSocket.OPEN || this.id == null) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError');
    }
    let text: string;
    if (typeof data === 'string') text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data);
    else throw new TypeError('Only text and byte frames are supported');
    const id = this.id;
    this.outbound = this.outbound
      .then(() => invoke('nostr_tor_send', { id, data: text }))
      .catch(() => undefined);
  }

  close(code = 1000, reason = ''): void {
    if (this.closeRequested || this.closed) return;
    this.closeRequested = true;
    this.readyState = NativeWebSocket.CLOSING;
    if (this.id != null) {
      const id = this.id;
      this.id = null;
      // After every queued send, so `send(x); close()` still delivers x.
      this.outbound = this.outbound
        .then(() => invoke('nostr_tor_close', { id }))
        .catch(() => undefined);
      this.finish(code, reason, true);
    }
  }
}

/** `WebSocket` for this window: native sockets for remote relays, the
 *  webview's own only for plain loopback `ws:`. */
function BridgedWebSocket(
  this: unknown,
  url: string | URL,
  protocols?: string | string[]
) {
  const target = String(url);
  if (webviewSocketAllowed(target) && WebviewWebSocket) {
    return new WebviewWebSocket(target, protocols);
  }
  return new NativeWebSocket(target);
}
for (const [name, value] of Object.entries({
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
})) {
  Object.defineProperty(BridgedWebSocket, name, { value });
}
BridgedWebSocket.prototype = NativeWebSocket.prototype;

globalThis.WebSocket = BridgedWebSocket as unknown as typeof WebSocket;
