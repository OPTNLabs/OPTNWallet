import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { isNativePlatformMock, getPlatformMock } = vi.hoisted(() => ({
  isNativePlatformMock: vi.fn(),
  getPlatformMock: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: isNativePlatformMock,
    getPlatform: getPlatformMock,
  },
}));

import {
  isAndroidNativePlatform,
  isDesktopPlatform,
  isNativePlatform,
  isWebPlatform,
} from '../platform';

describe('platform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('recognizes the Tauri desktop WebView', () => {
    vi.stubGlobal('window', {});
    expect(isDesktopPlatform()).toBe(false);

    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    expect(isDesktopPlatform()).toBe(true);
  });

  it('reports web as non-native', () => {
    isNativePlatformMock.mockReturnValue(false);
    getPlatformMock.mockReturnValue('web');

    expect(isNativePlatform()).toBe(false);
    expect(isWebPlatform()).toBe(true);
    expect(isAndroidNativePlatform()).toBe(false);
  });

  it('reports android native correctly', () => {
    isNativePlatformMock.mockReturnValue(true);
    getPlatformMock.mockReturnValue('android');

    expect(isNativePlatform()).toBe(true);
    expect(isWebPlatform()).toBe(false);
    expect(isAndroidNativePlatform()).toBe(true);
  });

  it('reports ios native correctly', () => {
    isNativePlatformMock.mockReturnValue(true);
    getPlatformMock.mockReturnValue('ios');

    expect(isNativePlatform()).toBe(true);
    expect(isWebPlatform()).toBe(false);
    expect(isAndroidNativePlatform()).toBe(false);
  });
});
