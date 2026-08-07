#!/usr/bin/env node
/**
 * fusion-lab supervisor — VPS / always-on CashFusion lab process.
 *
 * Policy (matches desktop P2P CashFusion):
 *   - Tor is MANDATORY. Fail closed if SOCKS is unreachable.
 *   - Default network is chipnet; mainnet only if OPTN_NETWORK=mainnet.
 *   - Never bake secrets into the image; use OPTN_DATA_DIR volume.
 *
 * Full Auto fusion rounds (unlock + FusionRunnerService) are not started from
 * this process yet — this supervisor owns the ops contract (Tor, env, restart).
 * When a headless runner is wired, it must be invoked only after Tor is ready.
 */

import net from 'node:net';
import process from 'node:process';

const TOR_REQUIRED = (process.env.OPTN_TOR_REQUIRED ?? '1') !== '0';
const SOCKS = process.env.OPTN_TOR_SOCKS ?? 'tor:9050';
const NETWORK = (process.env.OPTN_NETWORK ?? 'chipnet').toLowerCase();
const DATA_DIR = process.env.OPTN_DATA_DIR ?? '/optn-data';
const PROBE_MS = Number(process.env.OPTN_TOR_PROBE_MS ?? 5000);
const RECHECK_MS = Number(process.env.OPTN_TOR_RECHECK_MS ?? 30_000);

function log(level, msg, extra) {
  const line = {
    ts: new Date().toISOString(),
    level,
    component: 'fusion-lab',
    msg,
    network: NETWORK,
    torSocks: SOCKS,
    dataDir: DATA_DIR,
    ...extra,
  };
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : 'log'](JSON.stringify(line));
}

function parseSocks(socks) {
  const [host, portStr] = socks.split(':');
  const port = Number(portStr ?? 9050);
  if (!host || !Number.isFinite(port)) {
    throw new Error(`Invalid OPTN_TOR_SOCKS=${socks}`);
  }
  return { host, port };
}

function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

async function requireTor() {
  if (!TOR_REQUIRED) {
    log('error', 'OPTN_TOR_REQUIRED=0 is not allowed for fusion-lab (P2P fail-closed)');
    process.exit(2);
  }
  const { host, port } = parseSocks(SOCKS);
  const ok = await probeTcp(host, port, PROBE_MS);
  if (!ok) {
    log('error', 'Tor SOCKS unreachable — fail closed (no clearnet fusion)', {
      host,
      port,
    });
    process.exit(3);
  }
  log('info', 'Tor SOCKS ready', { host, port });
}

function validateNetwork() {
  if (NETWORK !== 'chipnet' && NETWORK !== 'mainnet') {
    log('error', `Invalid OPTN_NETWORK=${NETWORK} (use chipnet|mainnet)`);
    process.exit(2);
  }
  if (NETWORK === 'mainnet') {
    log('info', 'MAINNET selected — hot wallet on VPS is high risk; operator accepts this');
  } else {
    log('info', 'network=chipnet (default; safe for lab / dogfood)');
  }
}

/**
 * Placeholder for headless Auto fusion.
 * When implemented, call FusionRunnerService only after requireTor() succeeds.
 */
function startHeadlessPlaceholder() {
  log('info', 'headless Auto fusion entrypoint not wired yet — supervisor holding Tor-bound env', {
    next: 'OPTN_HEADLESS_FUSION=1 + wallet unlock + FusionRunnerService loop',
  });
}

async function main() {
  log('info', 'fusion-lab supervisor starting (Tor mandatory for CashFusion)');
  validateNetwork();
  await requireTor();
  startHeadlessPlaceholder();

  // Keep process alive for docker restart policy; re-check Tor periodically.
  // If Tor dies, exit non-zero so `restart: unless-stopped` can recover.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, RECHECK_MS));
    const { host, port } = parseSocks(SOCKS);
    const ok = await probeTcp(host, port, PROBE_MS);
    if (!ok) {
      log('error', 'Tor SOCKS lost — exiting fail-closed');
      process.exit(3);
    }
    log('info', 'Tor SOCKS still healthy');
  }
}

main().catch((err) => {
  log('error', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
