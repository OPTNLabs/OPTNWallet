import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));

class NativeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = NativeSocket.CONNECTING;

  constructor(url: string) {
    this.url = url;
  }

  close(): void {
    this.readyState = NativeSocket.CLOSED;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('TorWebSocket lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('WebSocket', NativeSocket);
    mocks.listen.mockResolvedValue(() => undefined);
  });

  it('keeps Tor routing armed until every holder releases its token', async () => {
    mocks.invoke.mockResolvedValue(11);
    const { armTorRouting, TorWebSocket } = await import('../torWebSocket');

    const releaseA = armTorRouting({ host: '127.0.0.1', port: 17655 });
    const releaseB = armTorRouting({ host: '127.0.0.1', port: 17655 });
    releaseA();

    new TorWebSocket('wss://still-tor.example');
    await Promise.resolve();
    expect(mocks.invoke).toHaveBeenCalledWith(
      'nostr_tor_open',
      expect.objectContaining({ url: 'wss://still-tor.example' })
    );

    releaseB();
    mocks.invoke.mockClear();
    const direct = new TorWebSocket('wss://direct.example');
    expect(direct).toBeInstanceOf(NativeSocket);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('closes a native Tor connection that finishes opening after the caller cancelled', async () => {
    const opening = deferred<number>();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'nostr_tor_open') return opening.promise;
      return Promise.resolve();
    });
    const { armTorRouting, TorWebSocket } = await import('../torWebSocket');
    const release = armTorRouting({ host: '127.0.0.1', port: 17655 });

    const socket = new TorWebSocket('wss://slow.example');
    socket.close();
    opening.resolve(42);
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.invoke).toHaveBeenCalledWith('nostr_tor_close', { id: 42 });
    expect(socket.readyState).toBe(TorWebSocket.CLOSED);
    release();
  });
});
