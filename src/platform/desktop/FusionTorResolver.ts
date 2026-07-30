import type { TorConfig } from '../../services/fusion/FusionStatusService';
import {
  checkTorPort,
  detectTorPort,
  integratedTorStatus,
  type ManagedTorStatus,
} from './FusionStatusService';

export interface FusionTorSettings {
  enabled: boolean;
  auto: boolean;
  host: string;
  manualPort: number;
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
    return detected
      ? { type: 'tor', tor: { host: settings.host, port: detected } }
      : {
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
