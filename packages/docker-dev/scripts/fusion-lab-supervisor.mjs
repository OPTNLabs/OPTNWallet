#!/usr/bin/env node
/**
 * fusion-lab supervisor — VPS / always-on CashFusion lab process.
 *
 * Product policy (matches desktop):
 *   - Default fusion mode: **p2p** (OPTN_FUSION_MODE=server for classic server path)
 *   - Tor is MANDATORY — fail closed if SOCKS is unreachable
 *   - Default network: chipnet (OPTN_NETWORK=mainnet only if operator accepts risk)
 *   - Secrets only under OPTN_DATA_DIR volume
 *
 * Headless Auto rounds (wallet unlock + FusionRunnerService) need the full
 * desktop/Tauri stack (Tor WebSocket bridge is Rust). This process:
 *   1) Enforces Tor / mode / network
 *   2) Writes a health file for Docker
 *   3) If OPTN_HEADLESS_CMD is set, exec that command (future binary/script)
 *   4) Otherwise holds the Tor-bound env and re-checks Tor (restart policy)
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const TOR_REQUIRED = (process.env.OPTN_TOR_REQUIRED ?? '1') !== '0';
const SOCKS = process.env.OPTN_TOR_SOCKS ?? 'tor:9050';
/** Desktop default: P2P. */
const FUSION_MODE = (process.env.OPTN_FUSION_MODE ?? 'p2p').toLowerCase();
const NETWORK = (process.env.OPTN_NETWORK ?? 'chipnet').toLowerCase();
const DATA_DIR = process.env.OPTN_DATA_DIR ?? '/optn-data';
const HEALTH_FILE =
  process.env.OPTN_FUSION_HEALTH_FILE ?? path.join(DATA_DIR, 'fusion-lab.health.json');
const PROBE_MS = Number(process.env.OPTN_TOR_PROBE_MS ?? 5000);
const RECHECK_MS = Number(process.env.OPTN_TOR_RECHECK_MS ?? 30_000);
/** Optional external headless runner (full wallet stack). Example: path to a future CLI. */
const HEADLESS_CMD = process.env.OPTN_HEADLESS_CMD?.trim() || '';

function log(level, msg, extra) {
  const line = {
    ts: new Date().toISOString(),
    level,
    component: 'fusion-lab',
    msg,
    network: NETWORK,
    fusionMode: FUSION_MODE,
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

function writeHealth(status, extra = {}) {
  try {
    fs.mkdirSync(path.dirname(HEALTH_FILE), { recursive: true });
    fs.writeFileSync(
      HEALTH_FILE,
      JSON.stringify(
        {
          status,
          ts: new Date().toISOString(),
          fusionMode: FUSION_MODE,
          network: NETWORK,
          torSocks: SOCKS,
          ...extra,
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (err) {
    log('error', `health file write failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function requireTor() {
  if (!TOR_REQUIRED) {
    log('error', 'OPTN_TOR_REQUIRED=0 is not allowed for fusion-lab (Tor mandatory)');
    process.exit(2);
  }
  const { host, port } = parseSocks(SOCKS);
  const ok = await probeTcp(host, port, PROBE_MS);
  if (!ok) {
    writeHealth('tor_down', { host, port });
    log('error', 'Tor SOCKS unreachable — fail closed (no clearnet fusion)', {
      host,
      port,
    });
    process.exit(3);
  }
  log('info', 'Tor SOCKS ready', { host, port });
}

function validateMode() {
  if (FUSION_MODE !== 'p2p' && FUSION_MODE !== 'server') {
    log('error', `Invalid OPTN_FUSION_MODE=${FUSION_MODE} (use p2p|server; default p2p)`);
    process.exit(2);
  }
  log('info', `fusionMode=${FUSION_MODE}${FUSION_MODE === 'p2p' ? ' (default)' : ''}`);
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
 * Spawn optional full headless runner (must itself use Tor for p2p).
 * Returns a Promise that resolves when the child exits.
 */
function runHeadlessCmd() {
  if (!HEADLESS_CMD) return null;
  log('info', 'starting OPTN_HEADLESS_CMD', { cmd: HEADLESS_CMD });
  writeHealth('headless_running', { cmd: HEADLESS_CMD });
  return new Promise((resolve) => {
    const child = spawn(HEADLESS_CMD, {
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        OPTN_FUSION_MODE: FUSION_MODE,
        OPTN_NETWORK: NETWORK,
        OPTN_TOR_SOCKS: SOCKS,
        OPTN_TOR_REQUIRED: '1',
        OPTN_DATA_DIR: DATA_DIR,
      },
    });
    child.on('exit', (code, signal) => {
      log('info', 'OPTN_HEADLESS_CMD exited', { code, signal });
      resolve(code ?? 1);
    });
    child.on('error', (err) => {
      log('error', `OPTN_HEADLESS_CMD failed: ${err.message}`);
      resolve(1);
    });
  });
}

async function holdWithTorWatch() {
  writeHealth('ready_waiting_headless', {
    note: 'Tor up; set OPTN_HEADLESS_CMD for full Auto rounds (needs wallet stack)',
  });
  log('info', 'supervisor holding Tor-bound env (no OPTN_HEADLESS_CMD)');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, RECHECK_MS));
    const { host, port } = parseSocks(SOCKS);
    const ok = await probeTcp(host, port, PROBE_MS);
    if (!ok) {
      writeHealth('tor_down', { host, port });
      log('error', 'Tor SOCKS lost — exiting fail-closed');
      process.exit(3);
    }
    writeHealth('ready_waiting_headless', { tor: 'ok' });
    log('info', 'Tor SOCKS still healthy');
  }
}

async function main() {
  log('info', 'fusion-lab supervisor starting (Tor mandatory; default mode=p2p)');
  validateMode();
  validateNetwork();
  await requireTor();

  if (HEADLESS_CMD) {
    const code = await runHeadlessCmd();
    // If headless exits, fail so docker can restart (unless 0)
    process.exit(typeof code === 'number' ? code : 1);
  }

  await holdWithTorWatch();
}

main().catch((err) => {
  log('error', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
