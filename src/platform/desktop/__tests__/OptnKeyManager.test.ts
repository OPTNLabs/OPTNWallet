import { describe, expect, it, vi, beforeEach } from 'vitest';

// OptnKeyManager talks to the OS keychain (tauri-plugin-keyring-api) and OS
// biometry (@choochmeque/tauri-plugin-biometry-api) -- neither exists outside
// a real Tauri webview. Mock both with simple in-memory stores so the actual
// PBKDF2/AES-GCM setup/unlock/lock/changePassword logic (the part that
// matters for correctness) can be exercised directly.
const keychain = new Map<string, string>();
const keychainKey = (service: string, account: string) => `${service}:${account}`;

vi.mock('tauri-plugin-keyring-api', () => ({
  setPassword: vi.fn(async (service: string, account: string, value: string) => {
    keychain.set(keychainKey(service, account), value);
  }),
  getPassword: vi.fn(async (service: string, account: string) => {
    return keychain.get(keychainKey(service, account)) ?? null;
  }),
  deletePassword: vi.fn(async (service: string, account: string) => {
    keychain.delete(keychainKey(service, account));
  }),
}));

const biometricStore = new Map<string, string>();
vi.mock('@choochmeque/tauri-plugin-biometry-api', () => ({
  checkStatus: vi.fn(async () => ({ isAvailable: true })),
  setData: vi.fn(async ({ domain, name, data }: { domain: string; name: string; data: string }) => {
    biometricStore.set(`${domain}:${name}`, data);
  }),
  getData: vi.fn(async ({ domain, name }: { domain: string; name: string }) => ({
    data: biometricStore.get(`${domain}:${name}`) ?? null,
  })),
  hasData: vi.fn(async ({ domain, name }: { domain: string; name: string }) =>
    biometricStore.has(`${domain}:${name}`)
  ),
  removeData: vi.fn(async ({ domain, name }: { domain: string; name: string }) => {
    biometricStore.delete(`${domain}:${name}`);
  }),
}));

describe('OptnKeyManager', () => {
  beforeEach(async () => {
    keychain.clear();
    biometricStore.clear();
    vi.resetModules();
  });

  it('setup caches a key immediately and marks the gate as set up', async () => {
    const OptnKeyManager = (await import('../OptnKeyManager')).default;
    expect(await OptnKeyManager.hasSetup()).toBe(false);

    await OptnKeyManager.setup('correct horse battery staple');

    expect(await OptnKeyManager.hasSetup()).toBe(true);
    expect(OptnKeyManager.isUnlocked()).toBe(true);
  });

  it('lock clears the cached key; unlock with the right password restores it', async () => {
    const OptnKeyManager = (await import('../OptnKeyManager')).default;
    await OptnKeyManager.setup('my-password');
    OptnKeyManager.lock();
    expect(OptnKeyManager.isUnlocked()).toBe(false);

    const ok = await OptnKeyManager.unlock('my-password');
    expect(ok).toBe(true);
    expect(OptnKeyManager.isUnlocked()).toBe(true);
  });

  it('unlock with the wrong password fails and leaves the gate locked', async () => {
    const OptnKeyManager = (await import('../OptnKeyManager')).default;
    await OptnKeyManager.setup('my-password');
    OptnKeyManager.lock();

    const ok = await OptnKeyManager.unlock('totally-wrong-password');
    expect(ok).toBe(false);
    expect(OptnKeyManager.isUnlocked()).toBe(false);
  });

  it('changePassword invalidates the old password and accepts the new one', async () => {
    const OptnKeyManager = (await import('../OptnKeyManager')).default;
    await OptnKeyManager.setup('old-password');
    await OptnKeyManager.changePassword('new-password');
    OptnKeyManager.lock();

    expect(await OptnKeyManager.unlock('old-password')).toBe(false);
    expect(await OptnKeyManager.unlock('new-password')).toBe(true);
  });

  it('reset removes the stored salt/verify token so hasSetup goes false again', async () => {
    const OptnKeyManager = (await import('../OptnKeyManager')).default;
    await OptnKeyManager.setup('my-password');
    await OptnKeyManager.reset();

    expect(await OptnKeyManager.hasSetup()).toBe(false);
    expect(OptnKeyManager.isUnlocked()).toBe(false);
  });
});
