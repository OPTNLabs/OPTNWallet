import { describe, expect, it } from 'vitest';
import { createMocknetSigningRequest } from '../mocknetSigningFixtures';

describe('mocknetSigningFixtures', () => {
  it('creates deterministic signing data from CashScript MockNetworkProvider', async () => {
    const request = await createMocknetSigningRequest();
    expect(request.network).toBe('mocknet');
    expect(request.sourceOutputs).toHaveLength(1);
    expect(request.metadata.requestId).toBe('mocknet-qr-signing-request');
    expect(request.application?.metadata).toMatchObject({
      provider: 'CashScript MockNetworkProvider',
      fixtureOutpoint: `${'11'.repeat(32)}:0`,
    });
  });
});
