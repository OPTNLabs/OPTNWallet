import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ desktop: true }));
vi.mock('../platform', () => ({ isDesktopPlatform: () => platform.desktop }));

import { localImageSrc } from '../remoteImage';

describe('localImageSrc on desktop', () => {
  beforeEach(() => {
    platform.desktop = true;
  });

  it('passes the app asset protocol and inline sources through', () => {
    for (const url of [
      'http://asset.localhost/C%3A/icon.png',
      'https://asset.localhost/icon.png',
      'data:image/png;base64,AAAA',
      '/assets/logo.png',
    ]) {
      expect(localImageSrc(url), url).toBe(url);
    }
  });

  it('asks Rust for every remote image', () => {
    for (const url of [
      'https://example.com/icon.png',
      '//cdn.example/icon.png',
      'https://asset.localhost.example.com/icon.png',
    ]) {
      expect(localImageSrc(url), url).toBeUndefined();
    }
  });

  it('uses remote URLs as they are off desktop', () => {
    platform.desktop = false;
    expect(localImageSrc('https://example.com/icon.png')).toBe(
      'https://example.com/icon.png'
    );
  });
});
