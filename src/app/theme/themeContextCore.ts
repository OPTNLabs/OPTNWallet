import { createContext } from 'react';
import {
  getLocalStorage,
  readStorageItem,
  writeStorageItem,
} from '../../utils/browserStorage';

/**
 * Appearance is four colour modes plus a skin, the same set `optn_app` owns
 * (`ThemeMode` / `UiSkin`). The names and the CSS class strings match that
 * Rust enum on purpose: desktop persists the selection through the shared
 * runtime, so this renderer and the Rust renderers cannot drift into two
 * different ideas of what "green" means.
 */
export type ThemeMode = 'light' | 'gray' | 'green' | 'dark';

/** Chrome on top of a mode. Not a second wallet. */
export type UiSkin = 'default' | 'cyberpunk';

export const THEME_MODES: ThemeMode[] = ['light', 'gray', 'green', 'dark'];
export const UI_SKINS: UiSkin[] = ['default', 'cyberpunk'];

export interface ThemeContextValue {
  mode: ThemeMode;
  skin: UiSkin;
  setMode: (mode: ThemeMode) => void;
  setSkin: (skin: UiSkin) => void;
  /** The existing two-state control: green surfaces, or true black. */
  toggleMode: () => void;
}

/**
 * Two keys, because the old one is ambiguous. It stored `'light' | 'dark'`
 * where "dark" meant this wallet's green surfaces; the mode set now also has a
 * real `dark` (OLED black) whose stored value would be the same string. Read
 * under one key and choosing Dark could never survive a restart — it would come
 * back as green every launch. The versioned key holds the four-mode value; the
 * legacy key is read only when it is absent.
 */
const THEME_STORAGE_KEY = 'wallet_theme_mode_v2';
const LEGACY_THEME_STORAGE_KEY = 'wallet_theme_mode';
const SKIN_STORAGE_KEY = 'wallet_ui_skin';

export const ThemeContext = createContext<ThemeContextValue | undefined>(
  undefined
);

export function isThemeMode(value: unknown): value is ThemeMode {
  return THEME_MODES.includes(value as ThemeMode);
}

export function isUiSkin(value: unknown): value is UiSkin {
  return UI_SKINS.includes(value as UiSkin);
}

/**
 * Translate a value written by the two-mode build. "dark" there was green, so
 * anyone who chose it gets the same colours back rather than OLED black for a
 * choice they never made.
 */
export function normalizeLegacyMode(saved: string | null): ThemeMode | null {
  if (saved === 'dark') return 'green';
  if (saved === 'light') return 'light';
  return null;
}

export const getInitialTheme = (): ThemeMode => {
  const storage = getLocalStorage();
  const stored = readStorageItem(storage, THEME_STORAGE_KEY);
  if (isThemeMode(stored)) return stored;

  const migrated = normalizeLegacyMode(
    readStorageItem(storage, LEGACY_THEME_STORAGE_KEY)
  );
  if (migrated) return migrated;

  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'green';
  }

  return 'light';
};

export const getInitialSkin = (): UiSkin => {
  const saved = readStorageItem(getLocalStorage(), SKIN_STORAGE_KEY);
  return isUiSkin(saved) ? saved : 'default';
};

/** Every mode but Light paints dark surfaces, which is what `dark:` keys off. */
export const isDarkSurface = (mode: ThemeMode): boolean => mode !== 'light';

/**
 * Apply the selection to the document and remember it locally.
 *
 * The `dark` class stays on for every dark-surfaced mode because Tailwind's
 * `dark:` variants and a large amount of existing CSS are written against it;
 * `theme-*` then narrows the palette, so adding a mode never silently drops
 * the styling the wallet already had.
 */
export const persistTheme = (mode: ThemeMode, skin: UiSkin = 'default') => {
  const root = document.documentElement;
  root.classList.toggle('dark', isDarkSurface(mode));
  for (const candidate of THEME_MODES) {
    root.classList.toggle(`theme-${candidate}`, candidate === mode);
  }
  for (const candidate of UI_SKINS) {
    root.classList.toggle(`skin-${candidate}`, candidate === skin);
  }
  root.setAttribute('data-theme', mode);
  root.setAttribute('data-skin', skin);
  const storage = getLocalStorage();
  writeStorageItem(storage, THEME_STORAGE_KEY, mode);
  writeStorageItem(storage, SKIN_STORAGE_KEY, skin);
};

export const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  light: 'Light',
  gray: 'Gray',
  green: 'Green',
  dark: 'Dark',
};

export const THEME_MODE_DESCRIPTIONS: Record<ThemeMode, string> = {
  light: 'Light surfaces, dark text',
  gray: 'Charcoal everyday dark',
  green: 'OPTN wallet green',
  dark: 'True black, for OLED screens',
};

export const UI_SKIN_LABELS: Record<UiSkin, string> = {
  default: 'Default',
  cyberpunk: 'Cyberpunk',
};

export const UI_SKIN_DESCRIPTIONS: Record<UiSkin, string> = {
  default: 'OPTN product chrome',
  cyberpunk: 'Neon accents on the same mode',
};
