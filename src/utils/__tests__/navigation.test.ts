import { describe, expect, it } from 'vitest';
import { getReturnPath } from '../navigation';

describe('getReturnPath', () => {
  it('keeps an internal absolute app route', () => {
    expect(
      getReturnPath(
        { state: { returnTo: '/apps?tab=wallet' }, search: '' },
        '/home'
      )
    ).toBe('/apps?tab=wallet');
  });

  it.each([
    'https://attacker.example',
    '//attacker.example/path',
    '\\attacker.example/path',
    '/\\attacker.example/path',
    'javascript:alert(1)',
    'settings',
  ])('rejects non-app return target %s', (returnTo) => {
    expect(getReturnPath({ state: { returnTo }, search: '' }, '/home')).toBe(
      '/home'
    );
  });

  it('rejects an encoded backslash target from the query string', () => {
    expect(
      getReturnPath(
        { state: null, search: '?returnTo=%2F%5Cattacker.example' },
        '/home'
      )
    ).toBe('/home');
  });
});
