import type { TorConfig } from '../../services/fusion/FusionStatusService';
import {
  checkTorPort,
  detectTorPort,
  integratedTorStatus,
  startIntegratedTor,
  type ManagedTorStatus,
} from './FusionStatusService';

export interface FusionTorSettings {
  enabled: boolean;
  auto: boolean;
  host: string;
  manualPort: number;
  /** If true, start the integrated Tor process when no external Tor is found.
   *  Makes the default behavior "auto" — use system Tor if available, otherwise
   *  fall back to the built-in process. Matches the auto-fuse default. */
  autoStartIntegrated?: boolean;
}

export interface FusionTorProbes {
  integratedStatus: () => Promise<ManagedTorStatus>;
  detectPort: (host: string) => Promise<number | null>;
  checkPort: (host: string, port: number) => Promise<boolean>;
}

export type FusionTransportRoute =
  | { type: 'direct' }
  | { type: 'tor'; tor: TorConfig }
  | { type: 'unavailable'; reason: string };

const defaultProbes: FusionTorProbes = {
  integratedStatus: integratedTorStatus,
  detectPort: detectTorPort,
  checkPort: checkTorPort,
};

/**
 * One-time startup check: ensure Tor is available for fusion. Checks in order:
 * 1. Integrated Tor already running → use it
 * 2. External Tor on ports 9050/9150 → use it
 * 3. Neither → start integrated Tor (built-in fallback)
 *
 * This runs once on wallet open so that when auto-fuse triggers, Tor is
 * already available — either the system's or the built-in one.
 */
export async function ensureTorAvailable(
  settings: FusionTorSettings,
  probes: FusionTorProbes = defaultProbes
): Promise<void> {
  if (!settings.enabled) return;

  // 1. Already running integrated Tor?
  try {
    const managed = await probes.integratedStatus();
    if (
      managed.running &&
      managed.bootstrap_percent >= 100 &&
      Number.isInteger(managed.socks_port) &&
      managed.socks_port > 0
    ) {
      return; // integrated Tor is ready
    }
  } catch {
    // ignore — will try external and fallback below
  }

  // 2. External Tor available?
  const detected = await probes.detectPort(settings.host).catch(() => null);
  if (detected) return; // system Tor is available

  // 3. Start integrated Tor as fallback
  try {
    await startIntegratedTor();
  } catch {
    // Best effort — if it fails, fusion will report unavailable when it tries.
  }
}

export function isLocalFusionDestination(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Resolve one privacy-safe route for Fusion.
 *
 * Electron Cash permits direct transport only to localhost. Remote server and
 * P2P relay traffic first prefer the app-managed Tor process, then an external
 * Tor daemon/Browser detected on 9050/9150, or a manually configured proxy that
 * has been positively identified as Tor.
 */
export async function resolveFusionTransport(
  destinationHost: string,
  settings: FusionTorSettings,
  probes: FusionTorProbes = defaultProbes
): Promise<FusionTransportRoute> {
  if (isLocalFusionDestination(destinationHost)) return { type: 'direct' };
  if (!settings.enabled) {
    return {
      type: 'unavailable',
      reason: 'Tor is disabled for a remote Fusion destination.',
    };
  }

  try {
    const managed = await probes.integratedStatus();
    if (
      managed.running &&
      managed.bootstrap_percent >= 100 &&
      Number.isInteger(managed.socks_port) &&
      managed.socks_port > 0 &&
      managed.socks_port <= 65_535
    ) {
      return {
        type: 'tor',
        tor: { host: settings.host, port: managed.socks_port },
      };
    }
  } catch {
    // The integrated process is optional. Continue to the configured external
    // Tor route instead of turning one status-query failure into a privacy
    // downgrade or a permanent auto-fusion outage.
  }

  if (settings.auto) {
    const detected = await probes.detectPort(settings.host).catch(() => null);
    if (detected) {
      return { type: 'tor', tor: { host: settings.host, port: detected } };
    }
    // No external Tor found. If autoStartIntegrated is enabled, start the
    // built-in Tor process so the user gets Tor privacy by default — matching
    // the auto-fuse default behavior.
    if (settings.autoStartIntegrated) {
      try {
        const socksPort = await startIntegratedTor();
        if (Number.isInteger(socksPort) && socksPort > 0 && socksPort <= 65_535) {
          return { type: 'tor', tor: { host: settings.host, port: socksPort } };
        }
      } catch {
        // Integrated Tor failed to start — fall through to unavailable.
      }
    }
    return {
      type: 'unavailable',
      reason: 'No verified Tor proxy was detected on ports 9050 or 9150.',
    };
  }

  const manualPort = settings.manualPort;
  const validPort =
    Number.isInteger(manualPort) && manualPort > 0 && manualPort <= 65_535;
  const verified =
    validPort &&
    (await probes.checkPort(settings.host, manualPort).catch(() => false));
  return verified
    ? { type: 'tor', tor: { host: settings.host, port: manualPort } }
    : {
        type: 'unavailable',
        reason: 'The configured Fusion proxy could not be verified as Tor.',
      };
}
