import { afterEach, describe, expect, it } from 'vitest';
import {
  armAutoFusionSession,
  disarmAutoFusionSession,
  isAutoFusionSessionArmed,
} from '../fusionAutoSession';

describe('automatic Fusion session gate', () => {
  afterEach(() => disarmAutoFusionSession());

  it('starts disarmed, including for a wallet with auto preference enabled', () => {
    expect(isAutoFusionSessionArmed(7)).toBe(false);
  });

  it('arms only the wallet that received the explicit start', () => {
    armAutoFusionSession(7);

    expect(isAutoFusionSessionArmed(7)).toBe(true);
    expect(isAutoFusionSessionArmed(8)).toBe(false);
  });

  it('can be cleared when the wallet session changes', () => {
    armAutoFusionSession(7);
    disarmAutoFusionSession(7);

    expect(isAutoFusionSessionArmed(7)).toBe(false);
  });
});
