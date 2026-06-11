import { createContext } from 'react';
import {
  getLocalStorage,
  readStorageItem,
  writeStorageItem,
} from '../../utils/browserStorage';

export type ThemeMode = 'light' | 'dark';

export interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
}

const THEME_STORAGE_KEY = 'wallet_theme_mode';

export const ThemeContext = createContext<ThemeContextValue | undefined>(
  undefined
);

export const getInitialTheme = (): ThemeMode => {
  const saved = readStorageItem(getLocalStorage(), THEME_STORAGE_KEY);
  if (saved === 'dark' || saved === 'light') {
    return saved;
  }

  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark';
  }

  return 'light';
};

export const persistTheme = (mode: ThemeMode) => {
  const root = document.documentElement;
  root.classList.toggle('dark', mode === 'dark');
  root.setAttribute('data-theme', mode);
  writeStorageItem(getLocalStorage(), THEME_STORAGE_KEY, mode);
};
