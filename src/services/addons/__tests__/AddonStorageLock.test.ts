import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAddonStorageLock } from '../AddonStorageLock';

describe('AddonStorageLock', () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    'navigator'
  );

  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('uses an exclusive Web Lock when the platform provides one', async () => {
    const request = vi.fn(async (_name, options, callback) => {
      expect(options).toEqual({ mode: 'exclusive' });
      return callback();
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { locks: { request } },
    });

    await expect(
      createAddonStorageLock('optn-addon-test').withLock(async () => 'ok')
    ).resolves.toBe('ok');
    expect(request).toHaveBeenCalledWith(
      'optn-addon-test',
      { mode: 'exclusive' },
      expect.any(Function)
    );
    expect(createAddonStorageLock('optn-addon-test').crossContext).toBe(true);
  });

  it('serializes same-name tasks when Web Locks are unavailable', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {},
    });
    let active = 0;
    let maximum = 0;
    const task = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return 42;
    });

    const lock = createAddonStorageLock('optn-addon-test');
    expect(lock.crossContext).toBe(false);
    await expect(Promise.all([lock.withLock(task), lock.withLock(task)])).resolves.toEqual([
      42,
      42,
    ]);
    expect(maximum).toBe(1);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
