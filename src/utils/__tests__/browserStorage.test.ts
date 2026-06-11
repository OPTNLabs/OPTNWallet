import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getLocalStorage,
  getPreferredStorage,
  getSessionStorage,
  readStorageItem,
  writeStorageItem,
} from '../browserStorage';

const originalDescriptors = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
};

function restoreStorageProperty(name: 'localStorage' | 'sessionStorage') {
  const descriptor = originalDescriptors[name];
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }

  Reflect.deleteProperty(globalThis, name);
}

function defineStorageValue(
  name: 'localStorage' | 'sessionStorage',
  value: unknown
) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
  });
}

function defineThrowingStorage(name: 'localStorage' | 'sessionStorage') {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      throw new Error(`${name} unavailable`);
    },
  });
}

afterEach(() => {
  restoreStorageProperty('localStorage');
  restoreStorageProperty('sessionStorage');
  vi.restoreAllMocks();
});

describe('browserStorage', () => {
  it('reads and writes through a storage object while swallowing write failures', () => {
    const storage = {
      getItem: vi.fn((key: string) => (key === 'present' ? 'value' : null)),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    expect(readStorageItem(storage, 'present')).toBe('value');

    writeStorageItem(storage, 'present', 'next');
    expect(storage.setItem).toHaveBeenCalledWith('present', 'next');

    const failingStorage = {
      getItem: vi.fn(() => {
        throw new Error('blocked');
      }),
      setItem: vi.fn(() => {
        throw new Error('blocked');
      }),
      removeItem: vi.fn(),
    };

    expect(readStorageItem(failingStorage, 'any')).toBeNull();
    expect(() => writeStorageItem(failingStorage, 'any', 'value')).not.toThrow();
  });

  it('prefers localStorage when both browser stores are present', () => {
    const localStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const sessionStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    defineStorageValue('localStorage', localStorage);
    defineStorageValue('sessionStorage', sessionStorage);

    expect(getLocalStorage()).toBe(localStorage);
    expect(getSessionStorage()).toBe(sessionStorage);
    expect(getPreferredStorage()).toBe(localStorage);
  });

  it('falls back to sessionStorage when localStorage access fails', () => {
    const sessionStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    defineThrowingStorage('localStorage');
    defineStorageValue('sessionStorage', sessionStorage);

    expect(getLocalStorage()).toBeNull();
    expect(getPreferredStorage()).toBe(sessionStorage);
  });
});
