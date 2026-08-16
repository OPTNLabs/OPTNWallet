import { describe, expect, it } from 'vitest';
import { ADVANCED_ACTIONS } from '../actionsConfig';

describe('Actions configuration', () => {
  it('does not surface the QR signing demo in the action list', () => {
    expect(ADVANCED_ACTIONS).not.toContainEqual(
      expect.objectContaining({ title: 'QR Signing Demo' })
    );
  });
});
