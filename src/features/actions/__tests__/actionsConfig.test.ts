import { describe, expect, it } from 'vitest';
import { ADVANCED_ACTIONS } from '../actionsConfig';

describe('Actions configuration', () => {
  it('does not surface the QR signing demo in the action list', () => {
    expect(ADVANCED_ACTIONS).not.toContainEqual(
      expect.objectContaining({ title: 'QR Signing Demo' })
    );
  });

  it('surfaces multisig setup under Advanced Actions', () => {
    expect(ADVANCED_ACTIONS).toContainEqual({
      title: 'Multisig Setup',
      description: 'Create or import a shared xpub multisig wallet',
      to: '/multisig/setup',
    });
  });
});
