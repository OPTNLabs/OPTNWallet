/**
 * Trezor Bridge client — Electron Cash / trezorlib model.
 *
 * EC uses `trezorlib.transport` from the **native process** (not a browser).
 * Safe 5 is WebUSB → only Bridge (Suite/trezord on 127.0.0.1:21325).
 *
 * All HTTP goes through Tauri Rust (`hw::trezor_bridge::*`). WebView fetch is
 * blocked by CSP and is not the EC approach.
 */

export type BridgeDevice = {
  path: string;
  vendor: number;
  product: number;
  session?: string | null;
  debug?: boolean;
};

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke<T>(cmd, args);
}

export async function bridgePing(): Promise<{ version: string } | null> {
  try {
    const version = await invoke<string | null>('trezor_bridge_ping');
    if (version == null) return null;
    return { version };
  } catch {
    return null;
  }
}

export async function bridgeEnumerate(): Promise<BridgeDevice[]> {
  const list = await invoke<BridgeDevice[]>('trezor_bridge_enumerate');
  return Array.isArray(list) ? list : [];
}

export async function bridgeAcquire(path: string): Promise<string> {
  // Strip our wizard prefix if present
  const p = path.startsWith('bridge:') ? path.slice('bridge:'.length) : path;
  return invoke<string>('trezor_bridge_acquire', { path: p });
}

export async function bridgeRelease(session: string): Promise<void> {
  try {
    await invoke('trezor_bridge_release', { session });
  } catch {
    /* best-effort */
  }
}

/**
 * One Bridge /call = one protobuf frame exchange (trezorlib Bridge transport).
 */
export async function bridgeCall(
  session: string,
  dataHex: string
): Promise<string> {
  return invoke<string>('trezor_bridge_call', {
    session,
    dataHex,
  });
}

export async function withBridgeSession<T>(
  path: string,
  fn: (session: string) => Promise<T>
): Promise<T> {
  const session = await bridgeAcquire(path);
  try {
    return await fn(session);
  } finally {
    await bridgeRelease(session);
  }
}
