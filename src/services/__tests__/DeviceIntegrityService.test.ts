import { beforeEach, describe, expect, it, vi } from 'vitest';

const assessMock = vi.fn();
const isNativePlatformMock = vi.fn();
const getPlatformMock = vi.fn();

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: isNativePlatformMock,
    getPlatform: getPlatformMock,
  },
}));

vi.mock('../../plugins/DeviceIntegrity', () => ({
  default: {
    assess: assessMock,
  },
}));

describe('DeviceIntegrityService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    assessMock.mockReset();
    isNativePlatformMock.mockReset();
    getPlatformMock.mockReset();
    isNativePlatformMock.mockReturnValue(true);
    getPlatformMock.mockReturnValue('android');
    assessMock.mockResolvedValue({
      compromised: true,
      reasons: ['adb_enabled'],
    });
  });

  it('does not enforce integrity checks by default in production builds', async () => {
    vi.stubEnv('PROD', true);

    const { default: DeviceIntegrityService } = await import('../DeviceIntegrityService');

    await expect(
      DeviceIntegrityService.assertDeviceIntegrity('fetchAddressPrivateKey')
    ).resolves.toBeUndefined();
    expect(assessMock).not.toHaveBeenCalled();
  });

  it('enforces integrity checks when explicitly enabled for production android', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_ENFORCE_DEVICE_INTEGRITY', 'true');

    const { default: DeviceIntegrityService } = await import('../DeviceIntegrityService');

    await expect(
      DeviceIntegrityService.assertDeviceIntegrity('fetchAddressPrivateKey')
    ).rejects.toThrow(
      'Blocked on compromised device (fetchAddressPrivateKey): adb_enabled'
    );
    expect(assessMock).toHaveBeenCalledTimes(1);
  });
});
