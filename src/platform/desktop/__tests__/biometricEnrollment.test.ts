import { describe, expect, it, vi } from 'vitest';
import { resolveBiometricEnrollment } from '../biometricEnrollment';

describe('resolveBiometricEnrollment', () => {
  it('waits for biometric availability instead of treating an early check as unenrolled', async () => {
    const hasEnrollment = vi.fn(async () => true);

    await expect(
      resolveBiometricEnrollment(1, false, hasEnrollment)
    ).resolves.toBeNull();
    expect(hasEnrollment).not.toHaveBeenCalled();

    await expect(
      resolveBiometricEnrollment(1, true, hasEnrollment)
    ).resolves.toBe(1);
    expect(hasEnrollment).toHaveBeenCalledWith(1);
  });

  it('does not expose a biometric action for another or unenrolled wallet', async () => {
    const hasEnrollment = vi.fn(async () => false);

    await expect(
      resolveBiometricEnrollment(6, true, hasEnrollment)
    ).resolves.toBeNull();
    await expect(
      resolveBiometricEnrollment(null, true, hasEnrollment)
    ).resolves.toBeNull();
  });
});
