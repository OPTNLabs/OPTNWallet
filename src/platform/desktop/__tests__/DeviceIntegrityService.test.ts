import { afterEach, describe, expect, it, vi } from 'vitest';
import DeviceIntegrityService, {
  INTEGRITY_EVENT,
  markSpendAuthFromUnlock,
  rejectIntegrityCheck,
} from '../DeviceIntegrityService';
import { clearCachedPassword, setCachedPassword } from '../WalletKeyCache';

vi.mock('../../../state/store', () => ({
  store: { getState: () => ({ appLock: { autoLockMinutes: 0 } }) },
}));

afterEach(() => {
  rejectIntegrityCheck();
  clearCachedPassword();
  vi.unstubAllGlobals();
});

describe('desktop spend authorization session', () => {
  it('invalidates on lock and wallet switch without clearing a later unlock', async () => {
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    const prompted = vi.fn(() => rejectIntegrityCheck('Fresh authorization required'));
    events.addEventListener(INTEGRITY_EVENT, prompted);
    const spend = () => DeviceIntegrityService.assertDeviceIntegrity('fetchAddressPrivateKey_spend');

    setCachedPassword('public-test-password', new Uint8Array([1]), 1);
    markSpendAuthFromUnlock();
    await expect(spend()).resolves.toBeUndefined();
    expect(prompted).not.toHaveBeenCalled();

    clearCachedPassword();
    await expect(spend()).rejects.toThrow('Fresh authorization required');
    setCachedPassword('public-test-password', new Uint8Array([1]), 1);
    await expect(spend()).rejects.toThrow('Fresh authorization required');

    markSpendAuthFromUnlock();
    // Drain dynamic imports: lock must not schedule a delayed invalidation
    // that erases the newly granted authorization for this session.
    await vi.dynamicImportSettled();
    await expect(spend()).resolves.toBeUndefined();

    setCachedPassword('other-public-test-password', new Uint8Array([2]), 2);
    await expect(spend()).rejects.toThrow('Fresh authorization required');
    expect(prompted).toHaveBeenCalledTimes(3);
  });
});
