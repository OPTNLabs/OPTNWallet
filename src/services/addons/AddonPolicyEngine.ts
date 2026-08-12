import type { AddonCapability, AddonManifest } from '../../types/addons';

export type AddonPolicyTier = 'restricted' | 'reviewed' | 'internal';

export type AddonPolicyAuditEvent = {
  at: string;
  addonId: string;
  appId?: string;
  capability: AddonCapability;
  action: 'allow' | 'deny' | 'rate_limited';
  reason?: string;
};

export type AddonPolicyRuntimeAuthorizer = (args: {
  capability: AddonCapability;
  addonId: string;
}) => Promise<void> | void;

export type AddonPolicyEngineOptions = {
  manifest: AddonManifest;
  appId?: string;
  runtimeAuthorizer?: AddonPolicyRuntimeAuthorizer;
  auditSink?: (event: AddonPolicyAuditEvent) => void;
  maxAuditEvents?: number;
};

const ONE_MINUTE_MS = 60_000;
const DEFAULT_MAX_AUDIT_EVENTS = 300;

const BASE_LIMITS: Record<AddonCapability, number> = {
  'wallet:context:read': 300,
  'wallet:addresses:read': 120,
  'utxo:wallet:read': 120,
  'utxo:address:read': 120,
  'utxo:address:refresh': 60,
  'chain:query': 120,
  'tx:build': 90,
  'tx:add_output': 300,
  'tx:broadcast': 20,
  'contracts:derive': 120,
  'ui:confirm': 120,
  'signing:signature_template': 20,
  'http:fetch_json': 120,
};

function tierMultiplier(tier: AddonPolicyTier): number {
  switch (tier) {
    case 'internal':
      return 2;
    case 'reviewed':
      return 1;
    case 'restricted':
    default:
      return 0.5;
  }
}

function resolveTier(manifest: AddonManifest): AddonPolicyTier {
  const tier = manifest.trustTier;
  if (tier === 'internal' || tier === 'reviewed' || tier === 'restricted') {
    return tier;
  }
  return 'restricted';
}

export function createAddonPolicyEngine(options: AddonPolicyEngineOptions) {
  const tier = resolveTier(options.manifest);
  const usageByCapability = new Map<AddonCapability, number[]>();
  const auditEvents: AddonPolicyAuditEvent[] = [];
  const maxAuditEvents = Math.max(50, options.maxAuditEvents ?? DEFAULT_MAX_AUDIT_EVENTS);

  const emitAudit = (event: AddonPolicyAuditEvent) => {
    auditEvents.push(event);
    if (auditEvents.length > maxAuditEvents) {
      auditEvents.splice(0, auditEvents.length - maxAuditEvents);
    }
    options.auditSink?.(event);
  };

  const enforceRateLimit = (capability: AddonCapability) => {
    const now = Date.now();
    const minTime = now - ONE_MINUTE_MS;
    const current = usageByCapability.get(capability) ?? [];
    const recent = current.filter((ts) => ts >= minTime);

    const configured = BASE_LIMITS[capability];
    const limit = Math.max(1, Math.floor(configured * tierMultiplier(tier)));
    if (recent.length >= limit) {
      emitAudit({
        at: new Date().toISOString(),
        addonId: options.manifest.id,
        appId: options.appId,
        capability,
        action: 'rate_limited',
        reason: `limit=${limit}/min`,
      });
      throw new Error(
        `Addon "${options.manifest.id}" exceeded rate limit for capability "${capability}" (${limit}/min)`
      );
    }

    recent.push(now);
    usageByCapability.set(capability, recent);
  };

  const authorizeCapability = async (capability: AddonCapability) => {
    enforceRateLimit(capability);

    try {
      await options.runtimeAuthorizer?.({
        capability,
        addonId: options.manifest.id,
      });
      emitAudit({
        at: new Date().toISOString(),
        addonId: options.manifest.id,
        appId: options.appId,
        capability,
        action: 'allow',
      });
    } catch (e: unknown) {
      emitAudit({
        at: new Date().toISOString(),
        addonId: options.manifest.id,
        appId: options.appId,
        capability,
        action: 'deny',
        reason: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  };

  async function withTimeout<T>(
    operation: string,
    timeoutMs: number,
    run: () => Promise<T>
  ): Promise<T> {
    const ms = Math.max(1, timeoutMs);

    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Addon operation timed out: ${operation} (${ms}ms)`));
        }, ms);
      }),
    ]);
  }

  return {
    tier,
    authorizeCapability,
    withTimeout,
    getAuditTrail(): AddonPolicyAuditEvent[] {
      return auditEvents.slice();
    },
  };
}
