import { describe, expect, it, vi, beforeEach } from 'vitest';

// EcKeyManager talks to the OS keychain (tauri-plugin-keyring-api) and OS
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

describe('EcKeyManager', () => {
  beforeEach(async () => {
    keychain.clear();
    biometricStore.clear();
    vi.resetModules();
  });

  it('setup caches a key immediately and marks the gate as set up', async () => {
    const EcKeyManager = (await import('../EcKeyManager')).default;
    expect(await EcKeyManager.hasSetup()).toBe(false);

    await EcKeyManager.setup('correct horse battery staple');

    expect(await EcKeyManager.hasSetup()).toBe(true);
    expect(EcKeyManager.isUnlocked()).toBe(true);
  });

  it('lock clears the cached key; unlock with the right password restores it', async () => {
    const EcKeyManager = (await import('../EcKeyManager')).default;
    await EcKeyManager.setup('my-password');
    EcKeyManager.lock();
    expect(EcKeyManager.isUnlocked()).toBe(false);

    const ok = await EcKeyManager.unlock('my-password');
    expect(ok).toBe(true);
    expect(EcKeyManager.isUnlocked()).toBe(true);
  });

  it('unlock with the wrong password fails and leaves the gate locked', async () => {
    const EcKeyManager = (await import('../EcKeyManager')).default;
    await EcKeyManager.setup('my-password');
    EcKeyManager.lock();

    const ok = await EcKeyManager.unlock('totally-wrong-password');
    expect(ok).toBe(false);
    expect(EcKeyManager.isUnlocked()).toBe(false);
  });

  it('changePassword invalidates the old password and accepts the new one', async () => {
    const EcKeyManager = (await import('../EcKeyManager')).default;
    await EcKeyManager.setup('old-password');
    await EcKeyManager.changePassword('new-password');
    EcKeyManager.lock();

    expect(await EcKeyManager.unlock('old-password')).toBe(false);
    expect(await EcKeyManager.unlock('new-password')).toBe(true);
  });

  it('reset removes the stored salt/verify token so hasSetup goes false again', async () => {
    const EcKeyManager = (await import('../EcKeyManager')).default;
    await EcKeyManager.setup('my-password');
    await EcKeyManager.reset();

    expect(await EcKeyManager.hasSetup()).toBe(false);
    expect(EcKeyManager.isUnlocked()).toBe(false);
  });
});
