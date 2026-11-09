/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getInitialSkin,
  getInitialTheme,
  isDarkSurface,
  normalizeLegacyMode,
  persistTheme,
  THEME_MODES,
} from '../themeContextCore';

describe('theme modes', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('reads a previously stored "dark" as green Dark surfaces', () => {
    // "dark" used to name this wallet's green surfaces, which is still the
    // visual treatment of the new Dark mode.
    localStorage.setItem('wallet_theme_mode', 'dark');
    expect(normalizeLegacyMode('dark')).toBe('dark');
    expect(normalizeLegacyMode('light')).toBe('light');
    expect(normalizeLegacyMode('gray')).toBeNull();
    expect(getInitialTheme()).toBe('dark');
  });

  it('keeps the new Dark mode across a restart despite the legacy value', () => {
    // The four-mode value has its own key and wins over the legacy two-state
    // value, so explicit Gray/Green/Dark choices survive a restart.
    localStorage.setItem('wallet_theme_mode', 'dark');
    persistTheme('dark');
    expect(getInitialTheme()).toBe('dark');

    for (const mode of THEME_MODES) {
      persistTheme(mode);
      expect(getInitialTheme()).toBe(mode);
    }
  });

  it('keeps the dark class on for every dark-surfaced mode', () => {
    // Tailwind `dark:` variants and a lot of existing CSS are written against
    // `html.dark`. A new mode must only change colours, never drop styling.
    expect(isDarkSurface('light')).toBe(false);
    for (const mode of ['gray', 'green', 'dark'] as const) {
      persistTheme(mode);
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.classList.contains(`theme-${mode}`)).toBe(
        true
      );
    }
    persistTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('applies exactly one mode class and one skin class', () => {
    persistTheme('gray', 'cyberpunk');
    const classes = [...document.documentElement.classList];
    expect(classes.filter((name) => name.startsWith('theme-'))).toEqual([
      'theme-gray',
    ]);
    expect(classes.filter((name) => name.startsWith('skin-'))).toEqual([
      'skin-cyberpunk',
    ]);

    persistTheme('dark', 'default');
    const after = [...document.documentElement.classList];
    expect(after.filter((name) => name.startsWith('theme-'))).toEqual([
      'theme-dark',
    ]);
    expect(after.filter((name) => name.startsWith('skin-'))).toEqual([
      'skin-default',
    ]);
  });

  it('remembers the mode and skin for the next launch', () => {
    persistTheme('gray', 'cyberpunk');
    expect(getInitialTheme()).toBe('gray');
    expect(getInitialSkin()).toBe('cyberpunk');
  });
});
