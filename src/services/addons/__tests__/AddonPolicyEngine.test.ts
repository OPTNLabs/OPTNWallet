import { describe, expect, it } from 'vitest';
import { createAddonPolicyEngine } from '../AddonPolicyEngine';
import type { AddonManifest } from '../../../types/addons';

const manifest: AddonManifest = {
  id: 'test.addon',
  name: 'Test Addon',
  version: '1.0.0',
  permissions: [
    {
      kind: 'capabilities',
      capabilities: ['tx:broadcast', 'wallet:context:read'],
    },
  ],
  contracts: [
    {
      id: 'c1',
      name: 'Contract',
      cashscriptArtifact: {},
      functions: [],
    },
  ],
  trustTier: 'restricted',
};

describe('AddonPolicyEngine', () => {
  it('records allow audits on successful authorization', async () => {
    const policy = createAddonPolicyEngine({ manifest });
    await policy.authorizeCapability('wallet:context:read');

    const audit = policy.getAuditTrail();
    expect(audit.length).toBe(1);
    expect(audit[0].action).toBe('allow');
    expect(audit[0].capability).toBe('wallet:context:read');
  });

  it('records deny audits on runtime authorizer rejection', async () => {
    const policy = createAddonPolicyEngine({
      manifest,
      runtimeAuthorizer: async () => {
        throw new Error('denied');
      },
    });

    await expect(policy.authorizeCapability('tx:broadcast')).rejects.toThrow(
      'denied'
    );

    const audit = policy.getAuditTrail();
    expect(audit.length).toBe(1);
    expect(audit[0].action).toBe('deny');
  });

  it('enforces timeout wrapper', async () => {
    const policy = createAddonPolicyEngine({ manifest });
    await expect(
      policy.withTimeout('slow-op', 5, async () => {
        await new Promise((r) => setTimeout(r, 25));
        return true;
      })
    ).rejects.toThrow('timed out');
  });
});
