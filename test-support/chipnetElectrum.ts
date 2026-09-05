// A minimal Electrum client for the live chipnet tests.
//
// Public chipnet servers do not implement Fulcrum's `blockchain.reusable.*`, so
// the RPA live tests fetch and broadcast ordinary transactions instead. The
// server list is the same one scripts/probe-chipnet-chain.mjs uses.
//
// Not used by the app: nothing here ships. It exists so the chipnet proofs in
// src/services/__tests__/*.live.test.ts are reproducible by anyone with a
// funded chipnet wallet, rather than living in an untracked file.
import WebSocket from 'ws';

export const CHIPNET_SERVERS = [
  'electrum-chipnet.optnlabs.com',
  'chipnet.imaginary.cash',
  'chipnet.bch.ninja',
];

const PORT = 50004;

export type ElectrumCall = [id: number, method: string, params: unknown[]];

export type ElectrumResult = {
  host: string;
  err: string | null;
  results: Record<number, unknown>;
};

/** One connection, one batch of calls, resolved when every id has answered. */
export function rpc(
  host: string,
  calls: ElectrumCall[],
  timeoutMs = 30_000
): Promise<ElectrumResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://${host}:${PORT}`);
    const results: Record<number, unknown> = {};
    let done = false;

    const finish = (err: string | null) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({ host, err, results });
    };

    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    ws.on('open', () => {
      for (const [id, method, params] of calls) {
        ws.send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      }
    });

    ws.on('message', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        if (!line.trim()) continue;
        let message: { id?: number; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === undefined) continue;
        results[message.id] = message.error
          ? { error: message.error }
          : message.result;
        if (Object.keys(results).length === calls.length) {
          clearTimeout(timer);
          finish(null);
        }
      }
    });

    ws.on('error', (e: Error) => {
      clearTimeout(timer);
      finish(String(e.message || e));
    });
  });
}

/**
 * Try each server until one answers cleanly.
 *
 * Chipnet servers go down, fork, and disagree; a test that pinned one would
 * fail for reasons that have nothing to do with the code under test.
 */
export async function anyServer(
  calls: ElectrumCall[]
): Promise<ElectrumResult> {
  let last: ElectrumResult | null = null;
  for (const host of CHIPNET_SERVERS) {
    const out = await rpc(host, calls);
    last = out;
    const clean =
      !out.err &&
      Object.values(out.results).every(
        (r) => !(r && typeof r === 'object' && 'error' in (r as object))
      );
    if (clean) return out;
  }
  return last as ElectrumResult;
}
