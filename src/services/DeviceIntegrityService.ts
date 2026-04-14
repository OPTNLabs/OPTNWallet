import { Capacitor } from '@capacitor/core';
import DeviceIntegrity from '../plugins/DeviceIntegrity';

type CachedAssessment = {
  ts: number;
  compromised: boolean;
  reasons: string[];
};

const CACHE_TTL_MS = 60_000;
let cached: CachedAssessment | null = null;

function shouldEnforceIntegrityChecks(): boolean {
  return (
    import.meta.env.VITE_ENFORCE_DEVICE_INTEGRITY === 'true' &&
    import.meta.env.PROD &&
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === 'android'
  );
}

async function assessInternal(): Promise<CachedAssessment> {
  const now = Date.now();
  if (cached && now - cached.ts < CACHE_TTL_MS) {
    return cached;
  }

  const result = await DeviceIntegrity.assess();
  cached = {
    ts: now,
    compromised: !!result.compromised,
    reasons: Array.isArray(result.reasons) ? result.reasons : [],
  };
  return cached;
}

async function assertDeviceIntegrity(scope: string): Promise<void> {
  if (!shouldEnforceIntegrityChecks()) return;

  const result = await assessInternal();
  if (!result.compromised) return;

  const reasons = result.reasons.length > 0 ? result.reasons.join(', ') : 'unknown';
  throw new Error(`Blocked on compromised device (${scope}): ${reasons}`);
}

const DeviceIntegrityService = {
  assertDeviceIntegrity,
  assessInternal,
};

export default DeviceIntegrityService;
